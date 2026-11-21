import { BadRequestException } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { plainToInstance, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsISO8601,
  IsString, Matches, MaxLength, ValidateNested, validateSync,
} from 'class-validator';
import { validateBudgetPolicy, validateBudgetPrice } from './ai-budget-policy';
import {
  AiBudgetOverrideInput, AiBudgetPolicyInput, AiBudgetPriceInput,
  AiBudgetScope, AiBudgetWindow, PaidAiProvider,
} from './ai-budget.types';

// The final assertion makes the match consume the whole string, including newlines.
const AMOUNT = /^(?:0|[1-9][0-9]{0,18})$(?![\s\S])/;
const RATE = /^(?:0|[1-9][0-9]{0,8}|1000000000)$(?![\s\S])/;
const CHANGE_REFERENCE = /^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,11}$(?![\s\S])/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i;
const DATE_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})$(?![\s\S])/;
const MAX_EXTRA_TOKENS = 1000000n;
const MAX_EXTRA_NANOS = 100000000000n;

export class AiBudgetChangeReferenceDto {
  @ApiProperty({ example: 'OPS-818', description: 'Opaque operator change reference' })
  @IsString()
  @MaxLength(29)
  @Matches(CHANGE_REFERENCE)
  readonly changeReference: string;
}

export class AiBudgetPriceDto extends AiBudgetChangeReferenceDto {
  @ApiProperty({ enum: ['openai', 'anthropic'] })
  @IsIn(['openai', 'anthropic'])
  readonly provider: PaidAiProvider;

  @ApiProperty({ enum: ['gpt-4o-mini', 'claude-3-haiku-20240307', 'text-embedding-3-small'] })
  @IsIn(['gpt-4o-mini', 'claude-3-haiku-20240307', 'text-embedding-3-small'])
  readonly model: string;

  @ApiProperty({ type: String, example: '150' })
  @IsString()
  @Matches(RATE)
  readonly inputNanos: string;

  @ApiProperty({ type: String, example: '600' })
  @IsString()
  @Matches(RATE)
  readonly outputNanos: string;

  @ApiProperty({ type: String, example: '75' })
  @IsString()
  @Matches(RATE)
  readonly cachedInputNanos: string;
}

export class AiBudgetRuleDto {
  @ApiProperty({ enum: ['user', 'provider', 'global'] })
  @IsIn(['user', 'provider', 'global'])
  readonly scope: AiBudgetScope;

  @ApiProperty({ description: 'User UUID or *, or an explicit provider code' })
  @IsString()
  @MaxLength(36)
  readonly subject: string;

  @ApiProperty({ enum: ['day', 'month'] })
  @IsIn(['day', 'month'])
  readonly window: AiBudgetWindow;

  @ApiProperty({ type: String, example: '1000000' })
  @IsString()
  @Matches(AMOUNT)
  readonly tokenLimit: string;

  @ApiProperty({ type: String, example: '1000000000' })
  @IsString()
  @Matches(AMOUNT)
  readonly spendLimitUsdNanos: string;
}

export class AiBudgetPolicyDto extends AiBudgetChangeReferenceDto {
  @ApiProperty({ type: [AiBudgetRuleDto], maxItems: 32 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => AiBudgetRuleDto)
  readonly rules: readonly AiBudgetRuleDto[];
}

export class AiBudgetOverrideDto extends AiBudgetChangeReferenceDto {
  @ApiProperty({ format: 'uuid', description: 'The user receiving the bounded bonus' })
  @IsString()
  @Matches(UUID)
  readonly userId: string;

  @ApiProperty({ enum: ['day', 'month'] })
  @IsIn(['day', 'month'])
  readonly window: AiBudgetWindow;

  @ApiProperty({ type: String, maximum: 1000000, example: '1000' })
  @IsString()
  @Matches(AMOUNT)
  readonly extraTokens: string;

  @ApiProperty({ type: String, maximum: 100000000000, example: '1000000000' })
  @IsString()
  @Matches(AMOUNT)
  readonly extraSpendUsdNanos: string;

  @ApiProperty({ format: 'date-time', description: 'At most 24 hours and the current UTC window end' })
  @IsString()
  @MaxLength(40)
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(DATE_TIME)
  readonly expiresAt: string;
}

/** Revalidate callers that enter the service without the HTTP validation pipe. */
function readDto<T extends object>(
  constructor: new () => T,
  value: unknown,
  keys: readonly string[],
): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Invalid AI budget request');
  }
  const supplied = Object.keys(value);
  if (supplied.some((key) => !keys.includes(key)) ||
      keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new BadRequestException('Invalid AI budget request');
  }
  const dto = plainToInstance(constructor, value);
  if (validateSync(dto, {
    whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
  }).length) {
    throw new BadRequestException('Invalid AI budget request');
  }
  return dto;
}

export function readBudgetPriceInput(value: AiBudgetPriceInput): AiBudgetPriceInput {
  const dto = readDto(AiBudgetPriceDto, value, [
    'provider', 'model', 'inputNanos', 'outputNanos', 'cachedInputNanos', 'changeReference',
  ]);
  validateBudgetPrice(dto);
  return Object.freeze({ ...dto });
}

export function readBudgetPolicyInput(value: AiBudgetPolicyInput): AiBudgetPolicyInput {
  const dto = readDto(AiBudgetPolicyDto, value, ['rules', 'changeReference']);
  const rules = validateBudgetPolicy(dto.rules);
  return Object.freeze({
    changeReference: dto.changeReference,
    rules: Object.freeze(rules.map((rule) => Object.freeze({ ...rule }))),
  });
}

export function readBudgetOverrideInput(value: AiBudgetOverrideInput): AiBudgetOverrideInput {
  const dto = readDto(AiBudgetOverrideDto, value, [
    'userId', 'window', 'extraTokens', 'extraSpendUsdNanos', 'expiresAt', 'changeReference',
  ]);
  const tokens = BigInt(dto.extraTokens);
  const nanos = BigInt(dto.extraSpendUsdNanos);
  if (tokens > MAX_EXTRA_TOKENS || nanos > MAX_EXTRA_NANOS ||
      (tokens === 0n && nanos === 0n) || !Number.isFinite(Date.parse(dto.expiresAt))) {
    throw new BadRequestException('Invalid AI budget override');
  }
  return Object.freeze({
    ...dto, userId: dto.userId.toLowerCase(),
    expiresAt: new Date(dto.expiresAt).toISOString(),
  });
}

export function readBudgetChangeReference(value: { readonly changeReference: string }): string {
  return readDto(AiBudgetChangeReferenceDto, value, ['changeReference']).changeReference;
}

export function readBudgetOverrideId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new BadRequestException('Invalid AI budget override identifier');
  }
  return value.toLowerCase();
}

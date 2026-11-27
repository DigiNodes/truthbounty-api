import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

/**
 * Request DTO for evaluating a feature flag.
 * Environment is the only accepted parameter; user identity and roles
 * are derived from the authenticated principal or marked as anonymous.
 */
export class EvaluateFlagDto {
  @ApiProperty({
    description: 'Target environment for evaluation',
    example: 'production',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Environment must contain only lowercase letters, numbers, and hyphens',
  })
  environment?: string;
}

/**
 * Response DTO for flag evaluation.
 * Returns evaluation result without exposing internal targeting rules.
 */
export class FeatureFlagEvaluationDto {
  @ApiProperty({
    description: 'Feature flag key',
    example: 'enable-new-ui',
  })
  key: string;

  @ApiProperty({
    description: 'Whether the flag is enabled for this context',
    example: true,
  })
  enabled: boolean;

  @ApiProperty({
    description: 'Evaluation reason category',
    enum: [
      'boolean',
      'percentage',
      'user',
      'role',
      'environment',
      'time',
      'disabled',
    ],
    example: 'boolean',
  })
  reason: string;

  @ApiProperty({
    description: 'Whether evaluation used authenticated context',
    example: true,
  })
  authenticated: boolean;

  static fromEvaluationResult(
    result: { key: string; enabled: boolean; reason: string },
    authenticated: boolean,
  ): FeatureFlagEvaluationDto {
    const dto = new FeatureFlagEvaluationDto();
    dto.key = result.key;
    dto.enabled = result.enabled;
    dto.reason = result.reason;
    dto.authenticated = authenticated;
    return dto;
  }
}

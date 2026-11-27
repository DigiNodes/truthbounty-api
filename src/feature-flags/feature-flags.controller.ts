import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { AdminOnly } from '../auth/decorators/admin-only.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FeatureFlagsService } from './feature-flags.service';
import { ConfigurationService } from './configuration.service';
import { AuditTrailService } from '../audit/services/audit-trail.service';
import {
  AuditActionType,
  AuditEntityType,
} from '../audit/entities/audit-log.entity';
import { FeatureFlag } from './entities/feature-flag.entity';
import {
  ConfigurationHistoryResponseDto,
  ConfigurationReadResponseDto,
  ConfigurationValueResponseDto,
} from './dto/configuration-response.dto';
import {
  redactConfigurationValue,
  toConfigurationHistoryResponse,
  toConfigurationValueResponse,
} from './configuration-redaction';
import {
  CreateFeatureFlagInput,
  UpdateFeatureFlagInput,
} from './feature-flags.types';
import {
  PublicFeatureFlagDto,
  EvaluateFlagDto,
  FeatureFlagEvaluationDto,
  ListFlagsDto,
} from './dto';
import { AuthenticatedPrincipal } from '../auth/types/authenticated-request';

interface RequestWithUser {
  user?: { userId?: string; id?: string };
}

@ApiTags('Feature Flags & Configuration')
@Controller()
export class FeatureFlagsController {
  constructor(
    private readonly flagsService: FeatureFlagsService,
    private readonly configService: ConfigurationService,
    private readonly auditTrailService: AuditTrailService,
  ) {}

  @Get('feature-flags')
  @ApiOperation({
    summary: 'List public feature flags',
    description:
      'Returns only client-visible feature flags. Server-only flags and internal targeting rules are excluded.',
  })
  async listFlags(@Query() dto: ListFlagsDto): Promise<PublicFeatureFlagDto[]> {
    const flags = await this.flagsService.findAllPublic(dto.environment);
    return flags.map((flag) => PublicFeatureFlagDto.fromEntity(flag));
  }

  @Get('feature-flags/evaluate/:key')
  @ApiOperation({
    summary: 'Evaluate a feature flag',
    description:
      'Evaluates a feature flag using verified principal identity if authenticated, or anonymous context otherwise. Caller-supplied user/role parameters are not accepted.',
  })
  async evaluateFlag(
    @Param('key') key: string,
    @Query() dto: EvaluateFlagDto,
    @CurrentUser() principal?: AuthenticatedPrincipal,
  ): Promise<FeatureFlagEvaluationDto> {
    const result = await this.flagsService.evaluateForPrincipal(
      key,
      principal ?? null,
      dto.environment,
    );
    return FeatureFlagEvaluationDto.fromEvaluationResult(
      result,
      Boolean(principal),
    );
  }

  @Get('feature-flags/:id')
  @ApiOperation({
    summary: 'Get a public feature flag by id',
    description:
      'Returns a sanitized feature flag without internal targeting rules or operational metadata.',
  })
  async getFlag(@Param('id') id: string): Promise<PublicFeatureFlagDto> {
    const flag = await this.flagsService.findOne(id);
    // Filter server-only flags from public access
    if (flag.serverOnly) {
      throw new Error('Feature flag not found');
    }
    return PublicFeatureFlagDto.fromEntity(flag);
  }

  @Get('admin/feature-flags')
  @AdminOnly()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List all feature flags (admin)',
    description:
      'Returns complete feature flag records including server-only flags and internal configuration. Admin-only.',
  })
  async listFlagsAdmin(
    @Query('environment') environment?: string,
  ): Promise<FeatureFlag[]> {
    return this.flagsService.findAll(environment);
  }

  @Get('admin/feature-flags/:id')
  @AdminOnly()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get complete feature flag details (admin)',
    description:
      'Returns full feature flag entity including rules, targeting, and operational metadata. Admin-only.',
  })
  async getFlagAdmin(@Param('id') id: string): Promise<FeatureFlag> {
    return this.flagsService.findOne(id);
  }

  @Post('feature-flags')
  @AdminOnly()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a feature flag' })
  async createFlag(
    @Body() input: CreateFeatureFlagInput,
    @Request() req: RequestWithUser,
  ): Promise<FeatureFlag> {
    const userId = this.userIdFrom(req);
    const flag = await this.flagsService.create({
      ...input,
      createdBy: userId,
    });
    await this.auditTrailService.log({
      actionType: AuditActionType.CONFIG_CREATED,
      entityType: AuditEntityType.CONFIGURATION,
      entityId: flag.id,
      userId,
      description: `Created feature flag ${flag.key}`,
      afterState: flag,
    });
    return flag;
  }

  @Patch('feature-flags/:id')
  @AdminOnly()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a feature flag' })
  async updateFlag(
    @Param('id') id: string,
    @Body() input: UpdateFeatureFlagInput,
    @Request() req: RequestWithUser,
  ): Promise<FeatureFlag> {
    const userId = this.userIdFrom(req);
    const before = await this.flagsService.findOne(id);
    const flag = await this.flagsService.update(id, input, userId);
    await this.auditTrailService.log({
      actionType: AuditActionType.CONFIG_UPDATED,
      entityType: AuditEntityType.CONFIGURATION,
      entityId: flag.id,
      userId,
      description: `Updated feature flag ${flag.key}`,
      beforeState: before,
      afterState: flag,
    });
    return flag;
  }

  @Post('feature-flags/:id/toggle')
  @AdminOnly()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Toggle a feature flag' })
  async toggleFlag(
    @Param('id') id: string,
    @Body('enabled') enabled: boolean,
    @Request() req: RequestWithUser,
  ): Promise<FeatureFlag> {
    const userId = this.userIdFrom(req);
    const flag = await this.flagsService.toggle(id, enabled, userId);
    await this.auditTrailService.log({
      actionType: enabled
        ? AuditActionType.FEATURE_FLAG_ENABLED
        : AuditActionType.FEATURE_FLAG_DISABLED,
      entityType: AuditEntityType.CONFIGURATION,
      entityId: flag.id,
      userId,
      description: `${enabled ? 'Enabled' : 'Disabled'} feature flag ${flag.key}`,
      afterState: { enabled } as Record<string, any>,
    });
    return flag;
  }

  @Post('feature-flags/:id/rollback')
  @AdminOnly()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Rollback a feature flag to a historical version' })
  async rollbackFlag(
    @Param('id') id: string,
    @Body() input: RollbackFeatureFlagInput,
    @Request() req: RequestWithUser,
  ): Promise<FeatureFlag> {
    const userId = this.userIdFrom(req);
    const before = await this.flagsService.findOne(id);
    const flag = await this.flagsService.rollback(
      id,
      input.targetVersion,
      userId,
      input.reason,
      input.expectedVersion,
    );
    await this.auditTrailService.log({
      actionType: AuditActionType.CONFIG_ROLLED_BACK,
      entityType: AuditEntityType.CONFIGURATION,
      entityId: flag.id,
      userId,
      description: `Rolled back feature flag ${flag.key} from snapshot version ${input.targetVersion} to version ${flag.version}`,
      beforeState: before,
      afterState: flag,
      metadata: {
        sourceVersion: input.targetVersion,
        fromVersion: before.version,
        toVersion: flag.version,
        restoredFromVersion: flag.rolledBackFromVersion,
        reason: input.reason ?? null,
      },
    });
    return flag;
  }

  @Post('feature-flags/:id/emergency-disable')
  @AdminOnly()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Emergency disable a feature flag without rollback',
  })
  async emergencyDisableFlag(
    @Param('id') id: string,
    @Body() input: EmergencyDisableFeatureFlagInput,
    @Request() req: RequestWithUser,
  ): Promise<FeatureFlag> {
    const userId = this.userIdFrom(req);
    const before = await this.flagsService.findOne(id);
    const flag = await this.flagsService.emergencyDisable(
      id,
      userId,
      input.reason,
      input.expectedVersion,
    );
    await this.auditTrailService.log({
      actionType: AuditActionType.FEATURE_FLAG_DISABLED,
      entityType: AuditEntityType.CONFIGURATION,
      entityId: flag.id,
      userId,
      description: `Emergency disabled feature flag ${flag.key}`,
      beforeState: before,
      afterState: flag,
      metadata: {
        operation: 'emergency_disable',
        reason: input.reason ?? null,
        fromVersion: before.version,
        toVersion: flag.version,
      },
    });
    return flag;
  }

  @Get('feature-flags/:id/history')
  @ApiOperation({ summary: 'List immutable feature flag version snapshots' })
  getFlagHistory(@Param('id') id: string) {
    return this.flagsService.getHistory(id);
  }

  @Get('configuration')
  @AdminOnly()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List configuration values (administrator only)',
    description:
      'Returns configuration records only to administrators. Secret-classified values are redacted.',
  })
  @ApiOkResponse({ type: ConfigurationValueResponseDto, isArray: true })
  listConfig(
    @Query('environment') environment?: string,
  ): Promise<ConfigurationValueResponseDto[]> {
    return this.configService
      .findAll(environment)
      .then((records) => records.map(toConfigurationValueResponse));
  }

  @Get('configuration/:key')
  @AdminOnly()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get a configuration value (administrator only)',
    description: 'Secret-classified values are redacted.',
  })
  @ApiOkResponse({ type: ConfigurationReadResponseDto })
  async getConfig(
    @Param('key') key: string,
    @Query('environment') environment?: string,
  ): Promise<ConfigurationReadResponseDto> {
    const value = await this.configService.get(key, environment);
    return { key, value: redactConfigurationValue(key, value) };
  }

  @Post('configuration')
  @AdminOnly()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Set a configuration value' })
  @ApiOkResponse({ type: ConfigurationValueResponseDto })
  async setConfig(
    @Body()
    input: {
      key: string;
      value: unknown;
      environment?: string;
      changeReason?: string;
    },
    @Request() req: RequestWithUser,
  ): Promise<ConfigurationValueResponseDto> {
    const userId = this.userIdFrom(req);
    const existing = await this.configService.get(input.key, input.environment);
    const saved = await this.configService.set(
      input.key,
      input.value,
      input.environment,
      userId,
      input.changeReason,
    );
    await this.auditTrailService.log({
      actionType: existing
        ? AuditActionType.CONFIG_UPDATED
        : AuditActionType.CONFIG_CREATED,
      entityType: AuditEntityType.CONFIGURATION,
      entityId: saved.id,
      userId,
      description: `${existing ? 'Updated' : 'Created'} configuration ${saved.key}`,
      beforeState: existing ? { value: existing } : undefined,
      afterState: { value: saved.value, changeReason: input.changeReason },
    });
    return toConfigurationValueResponse(saved);
  }

  @Delete('configuration/:id')
  @AdminOnly()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a configuration value' })
  async deleteConfig(
    @Param('id') id: string,
    @Request() req: RequestWithUser,
  ): Promise<void> {
    const userId = this.userIdFrom(req);
    const before = await this.configService.findOne(id);
    await this.configService.delete(id);
    await this.auditTrailService.log({
      actionType: AuditActionType.CONFIG_DELETED,
      entityType: AuditEntityType.CONFIGURATION,
      entityId: id,
      userId,
      description: `Deleted configuration ${before.key}`,
      beforeState: before,
    });
  }

  @Get('configuration/:key/history')
  @AdminOnly()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get configuration history (administrator only)',
    description: 'Historical secret-classified values are redacted.',
  })
  @ApiOkResponse({ type: ConfigurationHistoryResponseDto, isArray: true })
  getHistory(
    @Param('key') key: string,
    @Query('environment') environment?: string,
  ) {
    return this.configService
      .getHistory(key, environment)
      .then((records) => records.map(toConfigurationHistoryResponse));
  }

  @Post('configuration/:id/rollback')
  @AdminOnly()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Rollback a configuration value' })
  @ApiOkResponse({ type: ConfigurationValueResponseDto })
  async rollbackConfig(
    @Param('id') id: string,
    @Body('targetVersion') targetVersion: number,
    @Request() req: RequestWithUser,
  ): Promise<ConfigurationValueResponseDto> {
    const userId = this.userIdFrom(req);
    const config = await this.configService.rollback(id, targetVersion, userId);
    await this.auditTrailService.log({
      actionType: AuditActionType.CONFIG_ROLLED_BACK,
      entityType: AuditEntityType.CONFIGURATION,
      entityId: config.id,
      userId,
      description: `Rolled back configuration ${config.key} to version ${targetVersion}`,
      afterState: { version: config.version } as Record<string, any>,
    });
    return toConfigurationValueResponse(config);
  }

  @Post('configuration/promote')
  @AdminOnly()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Promote a configuration to another environment' })
  @ApiOkResponse({ type: ConfigurationValueResponseDto })
  async promoteConfig(
    @Body()
    input: {
      key: string;
      sourceEnvironment: string;
      targetEnvironment: string;
    },
    @Request() req: RequestWithUser,
  ): Promise<ConfigurationValueResponseDto> {
    const userId = this.userIdFrom(req);
    const sourceValue = await this.configService.getRequired(
      input.key,
      input.sourceEnvironment,
    );
    const saved = await this.configService.set(
      input.key,
      sourceValue,
      input.targetEnvironment,
      userId,
      `Promoted from ${input.sourceEnvironment}`,
    );
    await this.auditTrailService.log({
      actionType: AuditActionType.CONFIG_UPDATED,
      entityType: AuditEntityType.CONFIGURATION,
      entityId: saved.id,
      userId,
      description: `Promoted configuration ${saved.key} from ${input.sourceEnvironment} to ${input.targetEnvironment}`,
      afterState: { value: saved.value, environment: input.targetEnvironment },
    });
    return toConfigurationValueResponse(saved);
  }

  private userIdFrom(req: RequestWithUser): string | undefined {
    return req.user?.userId ?? req.user?.id;
  }
}

import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminGuard } from '../admin/guards/admin.guard';
import { RolesGuard } from '../admin/guards/roles.guard';
import { Roles } from '../admin/decorators/roles.decorator';
import { AdminRole } from '../admin/entities/admin.entity';
import { Idempotent } from '../common/idempotency/idempotent.decorator';
import { PublicErrorCode } from '../common/constants/error-codes';
import { AbuseAppealService } from './abuse-appeal.service';
import { AbuseSignalService } from './abuse-signal.service';
import { AbuseRequestLike, identityInputFromRequest, resolveAbuseSubject } from './abuse-subject';
import { ABUSE_POLICY, AbusePolicyConfig } from './abuse-signals.config';
import {
  AbuseActionAdminDto,
  AbuseAppealDto,
  AbuseAppealListDto,
  AbuseDecisionAdminDto,
  AbuseDecisionListDto,
  AbuseErrorDto,
  AbuseStatusAdminDto,
  AbuseApiVersions,
  DecideAbuseAppealDto,
  SubmitAbuseAppealDto,
} from './abuse-signals.dto';
import { AbuseAction, AbuseDecision, AbuseReleaseBinding } from './abuse-signals.types';

const ABUSE_READERS = [
  AdminRole.SUPER_ADMIN,
  AdminRole.ADMINISTRATOR,
  AdminRole.SECURITY_ANALYST,
  AdminRole.AUDITOR,
];

const ABUSE_REVIEWERS = [
  AdminRole.SUPER_ADMIN,
  AdminRole.ADMINISTRATOR,
  AdminRole.SECURITY_ANALYST,
];

/**
 * Abuse board and appeal endpoints (PREWAVE-BE-086, #681).
 *
 * Split by audience, because the two have opposite disclosure needs:
 *
 *  - **Reads and appeal decisions** are admin-plane (`AdminGuard` +
 *    `RolesGuard`) and carry the versioned reason code a reviewer needs in
 *    order to explain a decision. Guards are applied per route rather than at
 *    the class so that filing an appeal is not admin-gated.
 *  - **Filing an appeal** is subject-plane: any authenticated caller, against
 *    their own action only, and its response carries no reason code and no
 *    heuristic. The subject is resolved from the verified principal, never from
 *    a path parameter, so nobody can appeal somebody else's action.
 *
 * Nothing here mutates protocol state. An approved appeal lifts an abuse action
 * and nothing else.
 */
@ApiTags('AbuseSignals')
@ApiBearerAuth('JWT-auth')
@Controller('v1/abuse-signals')
export class AbuseSignalsController {
  constructor(
    private readonly signals: AbuseSignalService,
    private readonly appeals: AbuseAppealService,
    @Inject(ABUSE_POLICY) private readonly policy: AbusePolicyConfig,
  ) {}

  @Get('status')
  @UseGuards(AdminGuard, RolesGuard)
  @Roles(...ABUSE_READERS)
  @ApiOperation({
    summary: 'Abuse module activation, provenance status and bound actions',
    description: 'Reports activation and provenance only; never thresholds.',
  })
  @ApiOkResponse({ type: AbuseStatusAdminDto })
  status(): AbuseStatusAdminDto {
    const binding = this.signals.getBinding();
    return {
      schemaVersion: AbuseApiVersions.schema,
      modelVersion: AbuseApiVersions.model,
      configVersion: AbuseApiVersions.config,
      detectionEnabled: this.policy.enabled,
      enforcementActive: this.signals.enforcementActive(),
      releaseBound: binding !== null,
      actionsInForce: 0,
    };
  }

  @Get('decisions')
  @UseGuards(AdminGuard, RolesGuard)
  @Roles(...ABUSE_READERS)
  @ApiOperation({ summary: 'List abuse decisions with versioned reason codes' })
  @ApiOkResponse({ type: AbuseDecisionListDto })
  @ApiResponse({ status: 403, type: AbuseErrorDto })
  async listDecisions(
    @Query('subjectKey') subjectKey?: string,
    @Query('outcome') outcome?: AbuseDecision['outcome'],
    @Query('limit') limit?: string,
  ): Promise<AbuseDecisionListDto> {
    const decisions = await this.signals.listDecisions({
      subjectKey,
      outcome,
      limit: limit === undefined ? undefined : Number(limit),
    });
    return {
      decisions: decisions.map((decision) => this.toAdminDto(decision)),
      total: decisions.length,
    };
  }

  @Get('decisions/:id')
  @UseGuards(AdminGuard, RolesGuard)
  @Roles(...ABUSE_READERS)
  @ApiOperation({ summary: 'Get one abuse decision' })
  @ApiParam({ name: 'id', description: 'Deterministic decision id.' })
  @ApiOkResponse({ type: AbuseDecisionAdminDto })
  @ApiResponse({ status: 404, type: AbuseErrorDto })
  async getDecision(@Param('id') id: string): Promise<AbuseDecisionAdminDto> {
    const decision = await this.signals.getDecision(id);
    if (!decision) throw notFound('The decision was not found.');
    return this.toAdminDto(decision);
  }

  @Post('decisions/:id/appeal')
  @Idempotent()
  @ApiOperation({
    summary: 'Appeal an automated action issued against your own account',
    description:
      'The response carries only your appeal. Signal reason codes and ' +
      'heuristics are intentionally withheld so that appealing cannot be used ' +
      'to probe the detector.',
  })
  @ApiParam({ name: 'id', description: 'Decision that carries the action.' })
  @ApiResponse({ status: 201, type: AbuseAppealDto })
  @ApiResponse({ status: 403, type: AbuseErrorDto })
  @ApiResponse({ status: 404, type: AbuseErrorDto })
  @ApiResponse({ status: 429, type: AbuseErrorDto })
  async submitAppeal(
    @Param('id') id: string,
    @Body() body: SubmitAbuseAppealDto,
    @Req() req: AbuseRequestLike,
  ): Promise<AbuseAppealDto> {
    const decision = await this.signals.getDecision(id);
    if (!decision?.action) {
      throw notFound('No active action was found for this account.');
    }
    return this.run(async () => {
      const appeal = await this.appeals.submitAppeal({
        resolution: this.subjectOf(req),
        actionId: decision.action!.id,
        reason: body.reason,
      });
      // Projected, not passed through: the raw appeal carries the subject key
      // and the internal reason text, and neither belongs in a subject-facing
      // response body.
      return this.toDto(appeal);
    });
  }

  @Get('appeals')
  @UseGuards(AdminGuard, RolesGuard)
  @Roles(...ABUSE_REVIEWERS)
  @ApiOperation({ summary: 'List abuse appeals for review' })
  @ApiOkResponse({ type: AbuseAppealListDto })
  listAppeals(): AbuseAppealListDto {
    return {
      appeals: this.appeals.listAppeals().map((appeal) => this.toDto(appeal)),
    };
  }

  @Get('appeals/:id')
  @UseGuards(AdminGuard, RolesGuard)
  @Roles(...ABUSE_REVIEWERS)
  @ApiOperation({ summary: 'Get one abuse appeal' })
  @ApiParam({ name: 'id' })
  @ApiOkResponse({ type: AbuseAppealDto })
  getAppeal(@Param('id') id: string): AbuseAppealDto {
    const appeal = this.appeals.getAppeal(id);
    if (!appeal) throw notFound('The appeal was not found.');
    return this.toDto(appeal);
  }

  @Post('appeals/:id/decision')
  @Idempotent()
  @UseGuards(AdminGuard, RolesGuard)
  @Roles(...ABUSE_REVIEWERS)
  @ApiOperation({
    summary: 'Approve or reject an appeal; approval lifts the action',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: AbuseAppealDto })
  @ApiResponse({ status: 403, type: AbuseErrorDto })
  async decideAppeal(
    @Param('id') id: string,
    @Body() body: DecideAbuseAppealDto,
    @Req() req: { admin?: { id?: string } },
  ): Promise<AbuseAppealDto> {
    return this.run(async () => {
      const appeal = await this.appeals.decideAppeal({
        appealId: id,
        approved: body.approved,
        reviewerId: req.admin?.id ?? '',
        note: body.note,
      });
      return this.toDto(appeal);
    });
  }

  private subjectOf(req: AbuseRequestLike) {
    return resolveAbuseSubject(
      identityInputFromRequest(req, {
        trustedProxyHops: this.policy.trustedProxyHops,
        subjectSalt: this.policy.subjectSalt,
      }),
    );
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const typed = error as {
        status?: number;
        errorCode?: PublicErrorCode;
        message?: string;
      };
      if (typeof typed.status === 'number' && typed.errorCode) {
        throw new HttpException(
          {
            statusCode: typed.status,
            errorCode: typed.errorCode,
            message: typed.message ?? 'The request was refused.',
          },
          typed.status,
        );
      }
      throw error;
    }
  }

  private toDto(appeal: {
    id: string;
    actionId: string;
    status: string;
    submittedAt: string;
    reviewDueAt: string;
    decidedAt: string | null;
    decisionNote: string | null;
  }): AbuseAppealDto {
    return {
      id: appeal.id,
      actionId: appeal.actionId,
      status: appeal.status,
      submittedAt: appeal.submittedAt,
      reviewDueAt: appeal.reviewDueAt,
      decidedAt: appeal.decidedAt,
      decisionNote: appeal.decisionNote,
    };
  }

  private toAdminDto(decision: AbuseDecision): AbuseDecisionAdminDto {
    return {
      id: decision.id,
      subjectKey: decision.subjectKey,
      subjectKind: decision.subjectKind,
      outcome: decision.outcome,
      indeterminateReason: decision.indeterminateReason,
      reasonCode: decision.reasonCode,
      reasonCodeVersion: decision.reasonCodeVersion,
      severity: decision.severity,
      confidence: decision.confidence,
      sampleCount: decision.sampleCount,
      corroboratingDimensions: decision.corroboratingDimensions,
      modelVersion: decision.modelVersion,
      configVersion: decision.configVersion,
      binding: bindingDto(decision.binding),
      action: decision.action ? actionDto(decision.action) : null,
      decidedAt: decision.decidedAt,
    };
  }
}

function notFound(message: string): HttpException {
  return new HttpException(
    { statusCode: 404, errorCode: PublicErrorCode.NOT_FOUND, message },
    404,
  );
}

function bindingDto(
  binding: AbuseReleaseBinding | null,
): AbuseDecisionAdminDto['binding'] {
  if (!binding) return null;
  return {
    chainId: binding.chainId,
    releaseId: binding.releaseId,
    deploymentBlock: binding.deploymentBlock.toString(),
    artifactChecksum: binding.artifactChecksum,
  };
}

function actionDto(action: AbuseAction): AbuseActionAdminDto {
  return {
    id: action.id,
    kind: action.kind,
    status: action.status,
    reasonCode: action.reasonCode,
    reasonCodeVersion: action.reasonCodeVersion,
    startedAt: action.startedAt,
    expiresAt: action.expiresAt,
    escalationLevel: action.escalationLevel,
    appealable: action.appealable,
  };
}
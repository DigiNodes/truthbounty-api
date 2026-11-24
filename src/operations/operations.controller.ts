import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
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
import {
  CanonicalOperationsErrorDto,
  OperationalAuditRecordDto,
  OperationalQueueItemDto,
  OperationalQueueSummaryDto,
  RetryEligibilityDto,
  RetrySubmissionDto,
  SubmitRetryRequestDto,
} from './operations.dto';
import { OperationsError, OperationsService } from './operations.service';
import { OperationalCapability } from './operations.types';

const OPERATIONS_READERS = [
  AdminRole.SUPER_ADMIN,
  AdminRole.ADMINISTRATOR,
  AdminRole.SECURITY_ANALYST,
  AdminRole.AUDITOR,
];

/**
 * Protected operations board API (UX-BE-004, #595).
 *
 * Publishes bounded operational-queue reads, safe-retry eligibility and
 * submission, and audit-record lookup. Every handler is an admin-plane
 * (AdminGuard + RolesGuard) request; retry submission additionally requires an
 * `Idempotency-Key`, a precondition token and revalidated capability + expiry.
 *
 * No handler edits protocol state: reads relay derived queue metadata and a
 * retry only re-enqueues existing work through the queue source.
 */
@ApiTags('Operations')
@ApiBearerAuth('JWT-auth')
@Controller('v1/operations')
@UseGuards(AdminGuard, RolesGuard)
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  @Get('queue')
  @Roles(...OPERATIONS_READERS)
  @ApiOperation({ summary: 'List operational queue items and status counts' })
  @ApiOkResponse({ type: OperationalQueueSummaryDto })
  @ApiResponse({ status: 403, type: CanonicalOperationsErrorDto })
  async listQueue(): Promise<OperationalQueueSummaryDto> {
    return this.run(() => this.operations.listQueue());
  }

  @Get('queue/:id')
  @Roles(...OPERATIONS_READERS)
  @ApiOperation({ summary: 'Get one operational queue item' })
  @ApiParam({ name: 'id', description: 'Immutable work identifier.' })
  @ApiOkResponse({ type: OperationalQueueItemDto })
  @ApiResponse({ status: 404, type: CanonicalOperationsErrorDto })
  async getItem(@Param('id') id: string): Promise<OperationalQueueItemDto> {
    return this.run(() => this.operations.getItem(id));
  }

  @Get('queue/:id/retry-eligibility')
  @Roles(...OPERATIONS_READERS)
  @ApiOperation({
    summary: 'Whether a queue item can be retried, and why not if it cannot',
  })
  @ApiParam({ name: 'id', description: 'Immutable work identifier.' })
  @ApiOkResponse({ type: RetryEligibilityDto })
  @ApiResponse({ status: 404, type: CanonicalOperationsErrorDto })
  async getRetryEligibility(
    @Param('id') id: string,
  ): Promise<RetryEligibilityDto> {
    return this.run(() => this.operations.getRetryEligibility(id));
  }

  @Post('queue/:id/retry')
  @Idempotent()
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Submit an idempotent retry for a queue item' })
  @ApiParam({ name: 'id', description: 'Immutable work identifier.' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique key; a duplicate key replays the original outcome.',
  })
  @ApiHeader({
    name: 'X-Precondition-Token',
    required: true,
    description: 'Token from the retry-eligibility read.',
  })
  @ApiHeader({
    name: 'X-Authority-Capability',
    required: true,
    description: "Capability the caller's authority grants for this item.",
  })
  @ApiHeader({
    name: 'X-Authority-Expires-At',
    required: true,
    description:
      "ISO expiry of the caller's authority; revalidated fail-closed.",
  })
  @ApiResponse({ status: 202, type: RetrySubmissionDto })
  @ApiResponse({ status: 409, type: CanonicalOperationsErrorDto })
  @ApiResponse({ status: 503, type: CanonicalOperationsErrorDto })
  async submitRetry(
    @Param('id') id: string,
    @Body() body: SubmitRetryRequestDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-precondition-token') preconditionHeader: string | undefined,
    @Headers('x-authority-capability') capabilityHeader: string | undefined,
    @Headers('x-authority-expires-at') expiryHeader: string | undefined,
    @Req() req: { admin?: { id?: string } },
  ): Promise<RetrySubmissionDto> {
    return this.run(() =>
      this.operations.submitRetry({
        id,
        preconditionToken: body.preconditionToken ?? preconditionHeader,
        idempotencyKey,
        authorityCapability:
          capabilityHeader ?? OperationalCapability.RETRY_SUBMIT,
        authorityExpiresAt: expiryHeader,
        actorId: req.admin?.id,
        reason: body.reason,
        force: body.force,
      }),
    );
  }

  @Get('audit/:auditId')
  @Roles(...OPERATIONS_READERS)
  @ApiOperation({ summary: 'Look up a sanitized audit record by audit id' })
  @ApiParam({ name: 'auditId', description: 'Stable audit identifier.' })
  @ApiOkResponse({ type: OperationalAuditRecordDto })
  @ApiResponse({ status: 404, type: CanonicalOperationsErrorDto })
  async getAuditRecord(
    @Param('auditId') auditId: string,
  ): Promise<OperationalAuditRecordDto> {
    return this.run(() => this.operations.getAuditRecord(auditId));
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof OperationsError) {
        throw new HttpException(
          {
            statusCode: error.status,
            errorCode: error.errorCode,
            message: error.message,
            auditId: error.auditId,
            timestamp: new Date().toISOString(),
          },
          error.status,
        );
      }
      throw error;
    }
  }
}

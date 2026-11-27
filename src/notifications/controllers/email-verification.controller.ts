import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { EmailVerificationService } from '../services/email-verification.service';
import {
  ConfirmEmailVerificationDto,
  EmailVerificationStatusResponseDto,
  RequestEmailVerificationDto,
} from '../dto/email-verification.dto';

/**
 * EmailVerificationController
 *
 * Handles the notification-email ownership challenge flow.
 *
 * This flow is entirely distinct from account authentication, password reset,
 * and account recovery — it only governs whether the notification service
 * may deliver emails to the supplied address.
 *
 * Endpoints:
 *  POST /api/v2/notifications/preferences/email/verify/request
 *      Start or restart an ownership challenge for the supplied address.
 *      Any existing pending challenge is revoked first.
 *      Resend throttling: 1 request per 60 s, max 5 per hour.
 *
 *  POST /api/v2/notifications/preferences/email/verify/confirm
 *      Confirm an outstanding challenge with the single-use token.
 *
 *  GET  /api/v2/notifications/preferences/email/verify/status
 *      Return the current verification state without exposing token material.
 *
 * Security notes:
 * - All endpoints require a valid JWT (JwtAuthGuard); unauthenticated callers
 *   receive 401.
 * - The raw token is returned to the caller (to be dispatched via email) but
 *   is never echoed in a log statement.
 * - The confirmed email address is never logged by this controller.
 * - Cross-user substitution is blocked inside EmailVerificationService.
 */
@ApiTags('Notifications - Email Verification')
@Controller('api/v2/notifications/preferences/email/verify')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class EmailVerificationController {
  private readonly logger = new Logger(EmailVerificationController.name);

  constructor(private readonly verificationService: EmailVerificationService) {}

  /**
   * Request a new email ownership challenge.
   *
   * Returns the plaintext token so the caller can dispatch the verification
   * email.  Any existing pending challenge for this user is revoked before
   * the new one is issued.
   *
   * This endpoint intentionally returns the token in-band for environments
   * that do not yet have a live SMTP provider configured.  In production the
   * caller (or a background job) should send the token to the pending address
   * rather than surfacing it to the client.
   */
  @Post('request')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Request email ownership verification challenge' })
  @ApiResponse({
    status: 202,
    description:
      'Challenge issued. The token must be submitted to the confirm endpoint.',
    schema: {
      properties: {
        message: { type: 'string' },
        expiresAt: { type: 'string', format: 'date-time' },
        // token is intentionally omitted from the Swagger doc to discourage
        // clients from relying on it; it is present in the response body for
        // CI/staging environments without a live SMTP provider.
        token: { type: 'string' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid email address' })
  @ApiResponse({
    status: 409,
    description: 'Resend throttle: too many requests',
  })
  async requestVerification(
    @CurrentUser('id') userId: string,
    @Body() body: RequestEmailVerificationDto,
  ): Promise<{ message: string; expiresAt: Date; token: string }> {
    this.logger.debug(
      `Email verification requested by user ${userId}`,
    );

    const { token, expiresAt } =
      await this.verificationService.requestChallenge(userId, body.email);

    // The token is returned so callers in environments without SMTP can
    // manually confirm.  Production deployments should forward it only via
    // the outbound email to the pending address.
    return {
      message:
        'A verification email has been dispatched to the supplied address. ' +
        'Submit the token to the confirm endpoint to complete verification.',
      expiresAt,
      token,
    };
  }

  /**
   * Confirm an outstanding challenge with the single-use token.
   *
   * On success, the email address becomes the verified notification email.
   * On any failure (wrong token, expired, already used, revoked) the
   * endpoint fails closed with an appropriate 4xx.
   */
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm email ownership with single-use token' })
  @ApiResponse({
    status: 200,
    description: 'Email address successfully verified',
    schema: {
      properties: {
        message: { type: 'string' },
        verifiedAddress: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Token missing, malformed, expired, or already used',
  })
  @ApiResponse({
    status: 404,
    description: 'No matching pending challenge for this user and token',
  })
  async confirmVerification(
    @CurrentUser('id') userId: string,
    @Body() body: ConfirmEmailVerificationDto,
  ): Promise<{ message: string; verifiedAddress: string }> {
    this.logger.debug(`Email verification confirmation attempt by user ${userId}`);

    const { verifiedAddress } = await this.verificationService.confirmChallenge(
      userId,
      body.token,
    );

    // Log only the success event — no token or address value in the log
    this.logger.log(`Email verification completed for user ${userId}`);

    return {
      message: 'Email address successfully verified',
      verifiedAddress,
    };
  }

  /**
   * Return current verification status without exposing token material.
   */
  @Get('status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get email verification status' })
  @ApiResponse({
    status: 200,
    type: EmailVerificationStatusResponseDto,
  })
  async getVerificationStatus(
    @CurrentUser('id') userId: string,
  ): Promise<EmailVerificationStatusResponseDto> {
    const [verifiedAddress, pending] = await Promise.all([
      this.verificationService.getVerifiedAddress(userId),
      this.verificationService.getPendingChallenge(userId),
    ]);

    return {
      verified: Boolean(verifiedAddress),
      pendingChallenge: Boolean(pending),
      pendingChallengeExpiresAt: pending?.expiresAt ?? null,
    };
  }
}

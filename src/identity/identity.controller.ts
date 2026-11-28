import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { IdentityService } from './identity.service';
import { LinkWalletDto } from './dto/link-wallet.dto';
import { CreateWalletLinkChallengeDto } from './dto/create-wallet-link-challenge.dto';
import {
  AdminLinkWalletDto,
  AdminUnlinkWalletDto,
} from './dto/admin-wallet.dto';
import { SybilResistanceService } from '../sybil-resistance/sybil-resistance.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest } from '../auth/types/authenticated-request';
import { ThrottleByWallet } from '../common/decorators/throttle-by-wallet.decorator';
import { timingSafeEqualUtf8 } from '../common/utils/timing-safe.util';

/**
 * IdentityController — authorization aligned with the V2 API Authorization Matrix.
 *
 * READ routes  → PUBLIC  (sybil-score is chain-derived data, freely readable).
 * WRITE routes → AUTHN   (self-service mutations bound to authenticated principal).
 * ADMIN routes → ROLE(admin) (explicit admin-assisted routes with reason & audit).
 *
 * Worldcoin verification cannot be toggled via a boolean route here; it is
 * established exclusively through WorldcoinController → WorldcoinService.verifyProof().
 *
 * @see src/auth/authorization-matrix.ts
 */
@ApiTags('identity')
@Controller('identity')
export class IdentityController {
  constructor(
    private readonly identityService: IdentityService,
    private readonly sybilService: SybilResistanceService,
  ) {}

  // ── READ (public) ─────────────────────────────────────────────────────────

  @Get('users/:id')
  @ApiOperation({ summary: 'Get user by ID' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiResponse({ status: 200, description: 'User details' })
  @ApiResponse({ status: 404, description: 'User not found' })
  getUser(@Param('id') id: string) {
    return this.identityService.getUser(id);
  }

  @Get('users/:id/sybil-score')
  @ApiOperation({ summary: "Get user's current Sybil resistance score (sanitized public view)" })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiResponse({ status: 200, description: 'Sybil score details' })
  async getSybilScore(@Param('id') userId: string) {
    return this.sybilService.getPublicSybilScore(userId);
  }

  // ── WRITE (authenticated self-service, principal-bound) ──────────────────

  @Post('users')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new user identity' })
  @ApiResponse({ status: 201, description: 'User created' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  createUser() {
    return this.identityService.createUser();
  }

  @Post('users/:id/wallets/challenge')
  @UseGuards(JwtAuthGuard)
  @ThrottleByWallet('auth')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Issue a single-use wallet-link challenge for the caller',
  })
  @ApiParam({ name: 'id', description: 'User ID (must match authenticated principal)' })
  @ApiResponse({ status: 201, description: 'Challenge issued' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Path user ID does not match principal' })
  issueWalletLinkChallenge(
    @Param('id') userId: string,
    @Body() dto: CreateWalletLinkChallengeDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const principalId = this.assertSelfPrincipal(req, userId);
    return this.identityService.issueWalletLinkChallenge(
      principalId,
      dto.address,
      dto.chain,
    );
  }

  @Post('users/:id/wallets')
  @UseGuards(JwtAuthGuard)
  @ThrottleByWallet('auth')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Link a wallet to the authenticated user' })
  @ApiParam({ name: 'id', description: 'User ID (must match authenticated principal)' })
  @ApiResponse({ status: 201, description: 'Wallet linked' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Path user ID does not match principal' })
  linkWallet(
    @Param('id') userId: string,
    @Body() dto: LinkWalletDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const principalId = this.assertSelfPrincipal(req, userId);
    return this.identityService.linkWallet(principalId, dto);
  }

  @Delete('users/:id/wallets/:chain/:address')
  @UseGuards(JwtAuthGuard)
  @ThrottleByWallet('auth')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Unlink a wallet from the authenticated user' })
  @ApiParam({ name: 'id', description: 'User ID (must match authenticated principal)' })
  @ApiParam({ name: 'chain', description: 'Chain identifier' })
  @ApiParam({ name: 'address', description: 'Wallet address' })
  @ApiResponse({ status: 200, description: 'Wallet unlinked' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Path user ID does not match principal' })
  unlinkWallet(
    @Param('id') userId: string,
    @Param('chain') chain: string,
    @Param('address') address: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const principalId = this.assertSelfPrincipal(req, userId);
    return this.identityService.unlinkWallet(principalId, address, chain);
  }

  // ── ADMIN-ASSISTED IDENTITY MUTATIONS (least-privilege, audited) ─────────

  @Post('admin/users/:id/wallets/challenge')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Admin: issue a single-use wallet-link challenge for a target user',
  })
  @ApiParam({ name: 'id', description: 'Target User ID' })
  @ApiResponse({ status: 201, description: 'Challenge issued' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin privileges required' })
  adminIssueWalletLinkChallenge(
    @Param('id') targetUserId: string,
    @Body() dto: CreateWalletLinkChallengeDto,
    @Req() req: AuthenticatedRequest,
  ) {
    this.resolvePrincipalId(req);
    return this.identityService.issueWalletLinkChallenge(
      targetUserId,
      dto.address,
      dto.chain,
    );
  }

  @Post('admin/users/:id/wallets')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Admin: link a wallet to a target user with reason and audit log',
  })
  @ApiParam({ name: 'id', description: 'Target User ID' })
  @ApiResponse({ status: 201, description: 'Wallet linked' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin privileges required' })
  adminLinkWallet(
    @Param('id') targetUserId: string,
    @Body() dto: AdminLinkWalletDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const actorId = this.resolvePrincipalId(req);
    return this.identityService.adminLinkWallet(targetUserId, dto, actorId);
  }

  @Delete('admin/users/:id/wallets/:chain/:address')
  @Roles('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Admin: unlink a wallet from a target user with reason and audit log',
  })
  @ApiParam({ name: 'id', description: 'Target User ID' })
  @ApiParam({ name: 'chain', description: 'Chain identifier' })
  @ApiParam({ name: 'address', description: 'Wallet address' })
  @ApiResponse({ status: 200, description: 'Wallet unlinked' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin privileges required' })
  adminUnlinkWallet(
    @Param('id') targetUserId: string,
    @Param('chain') chain: string,
    @Param('address') address: string,
    @Body() dto: AdminUnlinkWalletDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const actorId = this.resolvePrincipalId(req);
    return this.identityService.adminUnlinkWallet(
      targetUserId,
      address,
      chain,
      actorId,
      dto.reason,
    );
  }

  private resolvePrincipalId(req: AuthenticatedRequest): string {
    const principal = req?.user;
    if (!principal || typeof principal !== 'object') {
      throw new UnauthorizedException('Authentication required');
    }
    const principalId = principal.sub ?? principal.userId;
    if (!principalId || typeof principalId !== 'string') {
      throw new UnauthorizedException('Authentication required');
    }
    return principalId;
  }

  private assertSelfPrincipal(
    req: AuthenticatedRequest,
    pathUserId: string,
  ): string {
    const principalId = this.resolvePrincipalId(req);
    if (!timingSafeEqualUtf8(principalId, pathUserId)) {
      throw new ForbiddenException('You may only modify your own identity');
    }
    return principalId;
  }
}
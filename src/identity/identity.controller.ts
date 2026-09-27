import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { IdentityService } from './identity.service';
import { LinkWalletDto } from './dto/link-wallet.dto';
import { SybilResistanceService } from '../sybil-resistance/sybil-resistance.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ThrottleByWallet } from '../common/decorators/throttle-by-wallet.decorator';

/**
 * IdentityController — authorization aligned with the V2 API Authorization Matrix.
 *
 * READ routes  → PUBLIC  (sybil-score is chain-derived data, freely readable).
 * WRITE routes → AUTHN   (any authenticated wallet-holder).
 *
 * Note: wallet linking/unlinking operates on the caller's own identity only.
 * Ownership enforcement (caller may only modify their own identity) is a
 * service-layer concern; the auth layer guarantees the caller is at minimum
 * authenticated before any mutation reaches the service.
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
  @ApiOperation({ summary: "Get user's current Sybil resistance score" })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiResponse({ status: 200, description: 'Sybil score details' })
  async getSybilScore(@Param('id') userId: string) {
    return this.sybilService.getLatestSybilScore(userId);
  }

  // ── WRITE (authenticated users only) ─────────────────────────────────────

  @Post('users')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new user identity' })
  @ApiResponse({ status: 201, description: 'User created' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  createUser() {
    return this.identityService.createUser();
  }

  @Post('users/:id/wallets')
  @UseGuards(JwtAuthGuard)
  @ThrottleByWallet('auth')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Link a wallet to a user' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiResponse({ status: 201, description: 'Wallet linked' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  linkWallet(@Param('id') userId: string, @Body() dto: LinkWalletDto) {
    return this.identityService.linkWallet(userId, dto);
  }

  @Delete('users/:id/wallets/:chain/:address')
  @UseGuards(JwtAuthGuard)
  @ThrottleByWallet('auth')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Unlink a wallet from a user' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiParam({ name: 'chain', description: 'Chain identifier' })
  @ApiParam({ name: 'address', description: 'Wallet address' })
  @ApiResponse({ status: 200, description: 'Wallet unlinked' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  unlinkWallet(
    @Param('id') userId: string,
    @Param('chain') chain: string,
    @Param('address') address: string,
  ) {
    return this.identityService.unlinkWallet(userId, address, chain);
  }

  @Post('users/:id/verify-worldcoin')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mark user as Worldcoin verified and recalculate Sybil score' })
  @ApiParam({ name: 'id', description: 'User ID' })
  @ApiResponse({ status: 201, description: 'Verification recorded' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async verifyWorldcoin(@Param('id') userId: string) {
    return this.sybilService.setWorldcoinVerified(userId, true);
  }
}

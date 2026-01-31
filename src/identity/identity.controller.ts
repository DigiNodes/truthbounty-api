import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { IdentityService } from './identity.service';
import { LinkWalletDto } from './dto/link-wallet.dto';
import { SybilResistanceService } from '../sybil-resistance/sybil-resistance.service';

@Controller('identity')
export class IdentityController {
  constructor(
    private readonly identityService: IdentityService,
    private readonly sybilService: SybilResistanceService,
  ) {}

  @Post('users')
  createUser() {
    return this.identityService.createUser();
  }

  @Get('users/:id')
  getUser(@Param('id') id: string) {
    return this.identityService.getUser(id);
  }

  @Post('users/:id/wallets')
  linkWallet(@Param('id') userId: string, @Body() dto: LinkWalletDto) {
    return this.identityService.linkWallet(userId, dto);
  }

  @Delete('users/:id/wallets/:chain/:address')
  unlinkWallet(
    @Param('id') userId: string,
    @Param('chain') chain: string,
    @Param('address') address: string,
  ) {
    return this.identityService.unlinkWallet(userId, address, chain);
  }

  /**
   * Mark user as Worldcoin verified and recalculate Sybil score
   */
  @Post('users/:id/verify-worldcoin')
  async verifyWorldcoin(@Param('id') userId: string) {
    // Update Worldcoin verification status and recalculate Sybil score
    return this.sybilService.setWorldcoinVerified(userId, true);
  }

  /**
   * Get user's current Sybil score
   */
  @Get('users/:id/sybil-score')
  async getSybilScore(@Param('id') userId: string) {
    return this.sybilService.getLatestSybilScore(userId);
  }
}

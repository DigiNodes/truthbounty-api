import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { IdentityService } from './identity.service';
import { LinkWalletDto } from './dto/link-wallet.dto';

@Controller('identity')
export class IdentityController {
  constructor(private readonly identityService: IdentityService) {}

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
}

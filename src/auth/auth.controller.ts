import { Controller, Post, Body, Get, Delete, UseGuards, Request, HttpCode, HttpStatus, UseFilters } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { ThrottleByWallet } from '../common/decorators/throttle-by-wallet.decorator';
import { ChallengeDto, RefreshDto, LogoutDto } from './dto/session.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AdminGuard } from './guards/admin.guard';
import { AdminOnly } from './decorators/admin-only.decorator';
import { Public } from '../decorators/public.decorator';
import { AuthExceptionFilter } from './filters/auth-exception.filter';

@ApiTags('auth')
@Controller('auth')
@UseFilters(AuthExceptionFilter)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ── Challenge ────────────────────────────────────────────────────────────

  @Post('challenge')
  @Public()
  @ThrottleByWallet('auth')
  @ApiOperation({ summary: 'Get a SIWE (EIP-4361) or legacy challenge message to sign with your wallet' })
  @ApiResponse({ status: 201, description: 'Challenge message generated' })
  @ApiResponse({ status: 400, description: 'Invalid address format' })
  async getChallenge(@Body() dto: ChallengeDto) {
    const { message, format } = await this.authService.generateChallenge(dto.address, {
      chainId: dto.chainId,
      domain: dto.domain,
      uri: dto.uri,
    });
    return { message, format, address: dto.address };
  }

  // ── Login ────────────────────────────────────────────────────────────────

  @Post('login')
  @Public()
  @ThrottleByWallet('auth')
  @ApiOperation({ summary: 'Login with wallet signature (supports SIWE and legacy formats)' })
  @ApiResponse({ status: 201, description: 'Login successful — returns access + refresh tokens' })
  @ApiResponse({ status: 401, description: 'Invalid signature, expired challenge, or address mismatch' })
  @ApiResponse({ status: 400, description: 'Malformed request' })
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  // ── Refresh ──────────────────────────────────────────────────────────────

  @Post('refresh')
  @Public()
  @ThrottleByWallet('auth')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh an expired access token using a valid refresh token' })
  @ApiResponse({ status: 200, description: 'New access + refresh tokens issued (rotation)' })
  @ApiResponse({ status: 401, description: 'Invalid, expired, or revoked refresh token' })
  async refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  // ── Logout ───────────────────────────────────────────────────────────────

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout — invalidates current access token and all refresh tokens for the user' })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async logout(@Request() req, @Body() _dto?: LogoutDto) {
    await this.authService.logout(req.user);
    return { message: 'Logged out successfully' };
  }

  // ── Revoke (Admin) ───────────────────────────────────────────────────────

  @Delete('sessions/:address')
  @UseGuards(JwtAuthGuard, AdminGuard)
  @AdminOnly()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin: Revoke all sessions for a wallet address' })
  @ApiResponse({ status: 200, description: 'All sessions revoked' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin privileges required' })
  async revoke(@Request() req) {
    const address: string = req.params.address;
    await this.authService.revoke(address);
    return { message: `All sessions revoked for ${address}` };
  }

  // ── Profile ──────────────────────────────────────────────────────────────

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get authenticated user profile' })
  @ApiResponse({ status: 200, description: 'User profile retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getProfile(@Request() req) {
    return req.user;
  }

  // ── Health ───────────────────────────────────────────────────────────────

  @Get('health')
  @Public()
  @ApiOperation({ summary: 'Authentication gateway health check' })
  @ApiResponse({ status: 200, description: 'Auth gateway is operational' })
  async health() {
    return {
      status: 'ok',
      service: 'Authentication Gateway',
      features: {
        siwe: true,
        jwt: true,
        refreshTokens: true,
        sessionRevocation: true,
        replayProtection: true,
      },
      supportedProviders: ['MetaMask', 'Rabby', 'WalletConnect', 'Coinbase Wallet'],
    };
  }
}

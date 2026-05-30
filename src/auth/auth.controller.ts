import { Controller, Post, Body, Get, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { ThrottleByWallet } from '../common/decorators/throttle-by-wallet.decorator';
import { ChallengeDto } from './dto/challenge.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { Public } from '../decorators/public.decorator';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('challenge')
  @Public()
  @ThrottleByWallet('auth')
  @ApiOperation({ summary: 'Get a challenge message to sign with your wallet' })
  @ApiResponse({ status: 200, description: 'Challenge message generated' })
  async getChallenge(@Body() dto: ChallengeDto) {
    const message = await this.authService.generateChallenge(dto.address);
    return { message, address: dto.address };
  }

  @Post('login')
  @Public()
  @ThrottleByWallet('auth')
  @ApiOperation({ summary: 'Login with wallet signature' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 401, description: 'Invalid signature or expired challenge' })
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get authenticated user profile' })
  @ApiResponse({ status: 200, description: 'User profile retrieved' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getProfile(@Request() req) {
    return req.user;
  }
}

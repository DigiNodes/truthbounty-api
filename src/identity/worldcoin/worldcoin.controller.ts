import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { WorldcoinService } from './worldcoin.service';
import { WorldcoinVerificationGuard } from './worldcoin-verification.guard';
import { VerifyWorldcoinDto } from './dto/verify-worldcoin.dto';

@ApiTags('identity/worldcoin')
@Controller('identity/worldcoin')
export class WorldcoinController {
  constructor(private readonly worldcoinService: WorldcoinService) {}

  /**
   * POST /identity/worldcoin/verify
   *
   * Submit a Worldcoin ZK proof to establish Sybil-resistant identity.
   *
   * Security:
   *  - Requires a valid JWT (JwtAuthGuard).
   *  - WorldcoinVerificationGuard ensures body.userId === authenticated principal.
   *  - Only the owner of an account may submit a proof for that account (IDOR guard).
   */
  @Post('verify')
  @UseGuards(JwtAuthGuard, WorldcoinVerificationGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify a user using Worldcoin ID' })
  @ApiResponse({
    status: 200,
    description: 'Worldcoin verification successful',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        verification: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            userId: { type: 'string' },
            verificationLevel: { type: 'string' },
            verifiedAt: { type: 'string' },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid proof or request' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'User ID does not match principal' })
  @ApiResponse({ status: 409, description: 'Proof already used' })
  @ApiResponse({
    status: 503,
    description: 'Worldcoin provider temporarily unavailable',
  })
  async verifyWorldcoin(@Body() verifyDto: VerifyWorldcoinDto) {
    const { userId, proof, action, signal } = verifyDto;

    const verification = await this.worldcoinService.verifyProof(userId, {
      proof,
      action,
      signal,
    });

    return {
      success: true,
      verification: {
        id: verification.id,
        userId: verification.userId,
        verificationLevel: verification.verificationLevel,
        verifiedAt: verification.verifiedAt,
      },
    };
  }

  /**
   * GET /identity/worldcoin/status/:userId
   *
   * Check the verification status for a user.  Read-only; publicly accessible
   * (does not return sensitive proof data).
   */
  @Get('status/:userId')
  @ApiOperation({ summary: 'Get verification status for a user' })
  @ApiParam({
    name: 'userId',
    description: 'User ID to check verification status for',
  })
  @ApiResponse({
    status: 200,
    description: 'Verification status retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        verified: { type: 'boolean' },
        verification: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            verificationLevel: { type: 'string' },
            verifiedAt: { type: 'string' },
          },
          nullable: true,
        },
      },
    },
  })
  async getVerificationStatus(@Param('userId') userId: string) {
    const verification =
      await this.worldcoinService.getVerificationStatus(userId);
    const isVerified = await this.worldcoinService.isUserVerified(userId);

    return {
      verified: isVerified,
      verification: verification
        ? {
            id: verification.id,
            verificationLevel: verification.verificationLevel,
            verifiedAt: verification.verifiedAt,
          }
        : null,
    };
  }

  /**
   * GET /identity/worldcoin/verification/:nullifierHash
   *
   * Look up a verification record by nullifier hash.
   * Returns only safe derived fields — raw proof bytes and proofHash are
   * never returned to API consumers.
   */
  @Get('verification/:nullifierHash')
  @ApiOperation({ summary: 'Get verification by nullifier hash' })
  @ApiParam({ name: 'nullifierHash', description: 'Nullifier hash to lookup' })
  @ApiResponse({ status: 200, description: 'Verification found' })
  @ApiResponse({ status: 404, description: 'Verification not found' })
  async getVerificationByNullifierHash(
    @Param('nullifierHash') nullifierHash: string,
  ) {
    const verification =
      await this.worldcoinService.getVerificationByNullifierHash(nullifierHash);

    if (!verification) {
      return {
        found: false,
        verification: null,
      };
    }

    return {
      found: true,
      // Return only safe derived fields — proofHash is audit-internal.
      verification: {
        id: verification.id,
        userId: verification.userId,
        verificationLevel: verification.verificationLevel,
        verifiedAt: verification.verifiedAt,
      },
    };
  }
}

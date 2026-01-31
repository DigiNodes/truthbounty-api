import { Controller, Post, Get, Body, Param, HttpCode, HttpStatus, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { WorldcoinService } from './worldcoin.service';
import { WorldIdVerification } from './entities/world-id-verification.entity';
import { VerifyWorldcoinDto } from './dto/verify-worldcoin.dto';

@ApiTags('identity/worldcoin')
@Controller('identity/worldcoin')
export class WorldcoinController {
  constructor(private readonly worldcoinService: WorldcoinService) {}

  @Post('verify')
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
          }
        }
      }
    }
  })
  @ApiResponse({ status: 400, description: 'Invalid proof or request' })
  @ApiResponse({ status: 409, description: 'Proof already used' })
  async verifyWorldcoin(@Body() verifyDto: VerifyWorldcoinDto) {
    const { userId, proof, action, signal } = verifyDto;

    const verification = await this.worldcoinService.verifyProof(userId, { proof, action, signal });

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

  @Get('status/:userId')
  @ApiOperation({ summary: 'Get verification status for a user' })
  @ApiParam({ name: 'userId', description: 'User ID to check verification status for' })
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
          nullable: true
        }
      }
    }
  })
  async getVerificationStatus(@Param('userId') userId: string) {
    const verification = await this.worldcoinService.getVerificationStatus(userId);
    const isVerified = await this.worldcoinService.isUserVerified(userId);

    return {
      verified: isVerified,
      verification: verification ? {
        id: verification.id,
        verificationLevel: verification.verificationLevel,
        verifiedAt: verification.verifiedAt,
      } : null,
    };
  }

  @Get('verification/:nullifierHash')
  @ApiOperation({ summary: 'Get verification by nullifier hash' })
  @ApiParam({ name: 'nullifierHash', description: 'Nullifier hash to lookup' })
  @ApiResponse({ status: 200, description: 'Verification found' })
  @ApiResponse({ status: 404, description: 'Verification not found' })
  async getVerificationByNullifierHash(@Param('nullifierHash') nullifierHash: string) {
    const verification = await this.worldcoinService.getVerificationByNullifierHash(nullifierHash);

    if (!verification) {
      return {
        found: false,
        verification: null,
      };
    }

    return {
      found: true,
      verification: {
        id: verification.id,
        userId: verification.userId,
        verificationLevel: verification.verificationLevel,
        verifiedAt: verification.verifiedAt,
      },
    };
  }
}

import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminGuard } from '../admin/guards/admin.guard';
import { RolesGuard } from '../admin/guards/roles.guard';
import { Roles } from '../admin/decorators/roles.decorator';
import { AdminRole } from '../admin/entities/admin.entity';
import {
  CredentialRotationService,
  CredentialDomain,
  CredentialStatusView,
} from './credential-rotation.service';
import { IsString, IsNotEmpty, IsOptional, IsNumber } from 'class-validator';

export class RotateCredentialDto {
  @IsString()
  @IsNotEmpty()
  newKeyId: string;

  @IsString()
  @IsNotEmpty()
  newSecret: string;

  @IsNumber()
  @IsOptional()
  overlapMs?: number;
}

export class RevokeKeyDto {
  @IsString()
  @IsNotEmpty()
  keyId: string;
}

@ApiTags('Credential Rotation')
@ApiBearerAuth()
@UseGuards(AdminGuard, RolesGuard)
@Controller('admin/credentials')
export class CredentialRotationController {
  constructor(
    private readonly credentialRotationService: CredentialRotationService,
  ) {}

  @Get('status')
  @Roles(
    AdminRole.SUPER_ADMIN,
    AdminRole.ADMINISTRATOR,
    AdminRole.SECURITY_ANALYST,
    AdminRole.AUDITOR,
  )
  @ApiOperation({ summary: 'Get credential rotation status across all domains' })
  async getStatus(
    @Query('domain') domain?: CredentialDomain,
  ): Promise<CredentialStatusView | CredentialStatusView[]> {
    return this.credentialRotationService.getStatus(domain);
  }

  @Post(':domain/rotate')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Rotate credential for a specific domain' })
  async rotateCredential(
    @Param('domain') domain: CredentialDomain,
    @Body() dto: RotateCredentialDto,
  ): Promise<{ activeKeyId: string; previousKeyId?: string }> {
    return this.credentialRotationService.rotateCredential(
      domain,
      dto.newKeyId,
      dto.newSecret,
      dto.overlapMs,
    );
  }

  @Post(':domain/rollback')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Rollback credential rotation for a domain' })
  async rollbackCredential(
    @Param('domain') domain: CredentialDomain,
  ): Promise<{ activeKeyId: string; rolledBackFrom: string }> {
    return this.credentialRotationService.rollbackCredential(domain);
  }

  @Post(':domain/revoke')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Revoke a specific key ID for a domain' })
  async revokeKey(
    @Param('domain') domain: CredentialDomain,
    @Body() dto: RevokeKeyDto,
  ): Promise<{ success: boolean }> {
    this.credentialRotationService.revokeKey(domain, dto.keyId);
    return { success: true };
  }
}

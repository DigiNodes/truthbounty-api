import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsBoolean,
  IsOptional,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AdminRole } from '../entities/admin.entity';

export class CreateAdminDto {
  @ApiProperty({
    description: 'Wallet address of the admin',
    example: '0x1234567890abcdef1234567890abcdef12345678',
  })
  @IsString()
  @IsNotEmpty()
  walletAddress: string;

  @ApiPropertyOptional({
    enum: AdminRole,
    default: AdminRole.AUDITOR,
    description:
      'Role to assign to the new admin (defaults to least-privilege role: auditor). Administrators can grant roles up to administrator; only super_admin can grant super_admin.',
  })
  @IsEnum(AdminRole)
  @IsOptional()
  role?: AdminRole;
}

export class UpdateAdminRoleDto {
  @ApiProperty({
    enum: AdminRole,
    description:
      'New role to assign to the admin. Administrators cannot promote accounts to super_admin.',
  })
  @IsEnum(AdminRole)
  @IsNotEmpty()
  role: AdminRole;
}

export class UpdateAdminStatusDto {
  @ApiProperty({ description: 'Whether the admin account is active' })
  @IsBoolean()
  @IsNotEmpty()
  isActive: boolean;
}

export class AdminResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  walletAddress: string;

  @ApiProperty({ enum: AdminRole })
  role: AdminRole;

  @ApiProperty()
  isActive: boolean;

  @ApiPropertyOptional()
  permissions: string[] | null;

  @ApiPropertyOptional()
  lastLoginAt: Date | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class AdminProfileResponseDto {
  @ApiProperty()
  admin: AdminResponseDto;

  @ApiProperty()
  permissions: string[];
}

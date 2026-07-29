import { IsString, IsNotEmpty, IsOptional, IsEnum, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AdminRole } from '../entities/admin.entity';

export class CreateAdminDto {
  @ApiProperty({ description: 'Wallet address of the admin' })
  @IsString()
  @IsNotEmpty()
  walletAddress: string;

  @ApiProperty({ enum: AdminRole, description: 'Admin role' })
  @IsEnum(AdminRole)
  @IsNotEmpty()
  role: AdminRole;
}

export class UpdateAdminRoleDto {
  @ApiProperty({ enum: AdminRole, description: 'New admin role' })
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

export class AdminLoginDto {
  @ApiProperty({ description: 'Admin login wallet address' })
  @IsString()
  @IsNotEmpty()
  address: string;
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

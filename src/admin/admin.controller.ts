import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam, ApiQuery } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { AdminGuard } from './guards/admin.guard';
import { RolesGuard } from './guards/roles.guard';
import { Roles } from './decorators/roles.decorator';
import { CurrentAdmin } from './decorators/current-admin.decorator';
import { Admin, AdminRole } from './entities/admin.entity';
import { CreateAdminDto, UpdateAdminRoleDto, UpdateAdminStatusDto, AdminLoginDto, AdminResponseDto } from './dto/admin.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Post('auth/login')
  @ApiOperation({ summary: 'Authenticate as admin' })
  @ApiResponse({ status: 200, description: 'Admin authenticated successfully' })
  @ApiResponse({ status: 403, description: 'Not an admin' })
  async login(@Body() loginDto: AdminLoginDto) {
    const admin = await this.adminService.findByWallet(loginDto.address);
    if (!admin) {
      return { authenticated: false, message: 'Admin not found' };
    }
    await this.adminService.recordLogin(admin.walletAddress);
    return {
      authenticated: true,
      admin: {
        id: admin.id,
        walletAddress: admin.walletAddress,
        role: admin.role,
        isActive: admin.isActive,
      },
    };
  }

  @Get('auth/profile')
  @UseGuards(AdminGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.MODERATOR, AdminRole.SECURITY_ANALYST, AdminRole.GOVERNANCE_OPERATOR, AdminRole.AUDITOR)
  @ApiOperation({ summary: 'Get current admin profile' })
  @ApiResponse({ status: 200, description: 'Admin profile' })
  async getProfile(@CurrentAdmin() admin: Admin) {
    return {
      id: admin.id,
      walletAddress: admin.walletAddress,
      role: admin.role,
      isActive: admin.isActive,
      lastLoginAt: admin.lastLoginAt,
      createdAt: admin.createdAt,
    };
  }

  @Post('admins')
  @UseGuards(AdminGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Create a new admin (super_admin or admin only)' })
  @ApiResponse({ status: 201, description: 'Admin created' })
  async createAdmin(@Body() createAdminDto: CreateAdminDto, @CurrentAdmin() admin: Admin) {
    return this.adminService.create(createAdminDto, admin);
  }

  @Get('admins')
  @UseGuards(AdminGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.AUDITOR)
  @ApiOperation({ summary: 'List all admins' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiResponse({ status: 200, description: 'List of admins' })
  async listAdmins(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.findAll(
      page ? parseInt(page, 10) : 1,
      limit ? Math.min(parseInt(limit, 10), 100) : 20,
    );
  }

  @Get('admins/:id')
  @UseGuards(AdminGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR, AdminRole.AUDITOR)
  @ApiOperation({ summary: 'Get admin by ID' })
  @ApiParam({ name: 'id', description: 'Admin ID' })
  async getAdmin(@Param('id') id: string) {
    return this.adminService.findById(id);
  }

  @Patch('admins/:id/role')
  @UseGuards(AdminGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Update admin role' })
  @ApiParam({ name: 'id', description: 'Admin ID' })
  async updateAdminRole(
    @Param('id') id: string,
    @Body() updateRoleDto: UpdateAdminRoleDto,
    @CurrentAdmin() admin: Admin,
  ) {
    return this.adminService.updateRole(id, updateRoleDto, admin);
  }

  @Patch('admins/:id/status')
  @UseGuards(AdminGuard, RolesGuard)
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Activate or deactivate an admin' })
  @ApiParam({ name: 'id', description: 'Admin ID' })
  async updateAdminStatus(
    @Param('id') id: string,
    @Body() updateStatusDto: UpdateAdminStatusDto,
    @CurrentAdmin() admin: Admin,
  ) {
    return this.adminService.updateStatus(id, updateStatusDto, admin);
  }
}

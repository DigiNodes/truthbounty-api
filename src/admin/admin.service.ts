import { Injectable, ConflictException, NotFoundException, Logger, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Admin, AdminRole, AdminRoleHierarchy } from './entities/admin.entity';
import { CreateAdminDto, UpdateAdminRoleDto, UpdateAdminStatusDto } from './dto/admin.dto';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectRepository(Admin)
    private readonly adminRepo: Repository<Admin>,
  ) {}

  async create(createAdminDto: CreateAdminDto, requestedBy: Admin): Promise<Admin> {
    if (!this.canManageAdmins(requestedBy.role)) {
      throw new ForbiddenException('Insufficient permissions to create admins');
    }

    const existing = await this.adminRepo.findOne({
      where: { walletAddress: createAdminDto.walletAddress.toLowerCase() },
    });

    if (existing) {
      throw new ConflictException('Admin with this wallet address already exists');
    }

    const admin = this.adminRepo.create({
      walletAddress: createAdminDto.walletAddress.toLowerCase(),
      role: createAdminDto.role,
      isActive: true,
    });

    const saved = await this.adminRepo.save(admin);
    this.logger.log(`Admin created: ${saved.id} with role ${saved.role}`);
    return saved;
  }

  async findAll(page = 1, limit = 20): Promise<{ data: Admin[]; total: number; page: number; limit: number }> {
    const [data, total] = await this.adminRepo.findAndCount({
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });

    return { data, total, page, limit };
  }

  async findById(id: string): Promise<Admin> {
    const admin = await this.adminRepo.findOneBy({ id });
    if (!admin) {
      throw new NotFoundException(`Admin with ID ${id} not found`);
    }
    return admin;
  }

  async findByWallet(walletAddress: string): Promise<Admin | null> {
    return this.adminRepo.findOne({
      where: { walletAddress: walletAddress.toLowerCase(), isActive: true },
    });
  }

  async updateRole(id: string, updateRoleDto: UpdateAdminRoleDto, requestedBy: Admin): Promise<Admin> {
    if (!this.canManageAdmins(requestedBy.role)) {
      throw new ForbiddenException('Insufficient permissions to update admin roles');
    }

    const admin = await this.findById(id);

    if (admin.role === AdminRole.SUPER_ADMIN && requestedBy.role !== AdminRole.SUPER_ADMIN) {
      throw new ForbiddenException('Cannot modify a super admin');
    }

    admin.role = updateRoleDto.role;
    const saved = await this.adminRepo.save(admin);
    this.logger.log(`Admin ${id} role updated to ${updateRoleDto.role}`);
    return saved;
  }

  async updateStatus(id: string, updateStatusDto: UpdateAdminStatusDto, requestedBy: Admin): Promise<Admin> {
    if (!this.canManageAdmins(requestedBy.role)) {
      throw new ForbiddenException('Insufficient permissions to update admin status');
    }

    const admin = await this.findById(id);

    if (admin.role === AdminRole.SUPER_ADMIN && requestedBy.role !== AdminRole.SUPER_ADMIN) {
      throw new ForbiddenException('Cannot modify a super admin');
    }

    admin.isActive = updateStatusDto.isActive;
    const saved = await this.adminRepo.save(admin);
    this.logger.log(`Admin ${id} status updated to ${updateStatusDto.isActive}`);
    return saved;
  }

  async recordLogin(walletAddress: string): Promise<Admin> {
    const admin = await this.adminRepo.findOne({
      where: { walletAddress: walletAddress.toLowerCase() },
    });

    if (!admin) {
      throw new NotFoundException('Admin not found');
    }

    admin.lastLoginAt = new Date();
    return this.adminRepo.save(admin);
  }

  private canManageAdmins(role: AdminRole): boolean {
    return role === AdminRole.SUPER_ADMIN || role === AdminRole.ADMINISTRATOR;
  }
}

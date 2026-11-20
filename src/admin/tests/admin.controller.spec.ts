import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminController } from '../admin.controller';
import { AdminService } from '../admin.service';
import { Admin, AdminRole } from '../entities/admin.entity';
import { AdminGuard } from '../guards/admin.guard';
import { RolesGuard } from '../guards/roles.guard';

describe('AdminController', () => {
  let controller: AdminController;
  let adminService: jest.Mocked<AdminService>;

  const mockAdmin: Admin = {
    id: 'admin-1',
    walletAddress: '0x123',
    role: AdminRole.ADMINISTRATOR,
    isActive: true,
    permissions: null,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockSuperAdmin: Admin = {
    ...mockAdmin,
    id: 'super-1',
    role: AdminRole.SUPER_ADMIN,
  };

  beforeEach(async () => {
    adminService = {
      login: jest.fn(),
      findByWallet: jest.fn(),
      recordLogin: jest.fn(),
      create: jest.fn(),
      findAll: jest.fn(),
      findById: jest.fn(),
      updateRole: jest.fn(),
      updateStatus: jest.fn(),
    } as unknown as jest.Mocked<AdminService>;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        {
          provide: AdminService,
          useValue: adminService,
        },
        {
          provide: getRepositoryToken(Admin),
          useValue: {},
        },
      ],
    })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AdminController>(AdminController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('createAdmin', () => {
    it('delegates creation to AdminService with caller context', async () => {
      adminService.create.mockResolvedValue(mockAdmin);
      const dto = { walletAddress: '0xabc', role: AdminRole.MODERATOR };

      const result = await controller.createAdmin(dto, mockSuperAdmin);

      expect(adminService.create).toHaveBeenCalledWith(dto, mockSuperAdmin);
      expect(result).toEqual(mockAdmin);
    });
  });

  describe('updateAdminRole', () => {
    it('delegates role update to AdminService with caller context', async () => {
      const updated = { ...mockAdmin, role: AdminRole.SECURITY_ANALYST };
      adminService.updateRole.mockResolvedValue(updated);
      const dto = { role: AdminRole.SECURITY_ANALYST };

      const result = await controller.updateAdminRole(
        'admin-1',
        dto,
        mockSuperAdmin,
      );

      expect(adminService.updateRole).toHaveBeenCalledWith(
        'admin-1',
        dto,
        mockSuperAdmin,
      );
      expect(result).toEqual(updated);
    });
  });

  describe('updateAdminStatus', () => {
    it('delegates status update to AdminService with caller context', async () => {
      const updated = { ...mockAdmin, isActive: false };
      adminService.updateStatus.mockResolvedValue(updated);
      const dto = { isActive: false };

      const result = await controller.updateAdminStatus(
        'admin-1',
        dto,
        mockSuperAdmin,
      );

      expect(adminService.updateStatus).toHaveBeenCalledWith(
        'admin-1',
        dto,
        mockSuperAdmin,
      );
      expect(result).toEqual(updated);
    });
  });

  describe('getProfile', () => {
    it('returns sanitized admin profile', async () => {
      const profile = await controller.getProfile(mockAdmin);
      expect(profile).toEqual({
        id: mockAdmin.id,
        walletAddress: mockAdmin.walletAddress,
        role: mockAdmin.role,
        isActive: mockAdmin.isActive,
        lastLoginAt: mockAdmin.lastLoginAt,
        createdAt: mockAdmin.createdAt,
      });
    });
  });
});

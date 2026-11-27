import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminController } from '../admin.controller';
import { AdminService } from '../admin.service';
import { Admin, AdminRole } from '../entities/admin.entity';
import { AdminGuard } from '../guards/admin.guard';
import { RolesGuard } from '../guards/roles.guard';
import { AuthenticatedRequest } from '../../auth/types/authenticated-request';

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

  describe('login', () => {
    it('throws UnauthorizedException when verified principal is missing', async () => {
      await expect(
        controller.login({} as AuthenticatedRequest),
      ).rejects.toThrow(UnauthorizedException);
      expect(adminService.findByWallet).not.toHaveBeenCalled();
    });

    it('returns non-enumerating failure response for non-admin wallet', async () => {
      adminService.findByWallet.mockResolvedValue(null);

      const result = await controller.login({
        user: { address: '0xnonadmin' },
      } as AuthenticatedRequest);

      expect(adminService.findByWallet).toHaveBeenCalledWith('0xnonadmin');
      expect(adminService.recordLogin).not.toHaveBeenCalled();
      expect(result).toEqual({
        authenticated: false,
        message: 'Authentication failed',
      });
    });

    it('records login and returns admin details for verified active admin', async () => {
      adminService.findByWallet.mockResolvedValue(mockAdmin);
      adminService.recordLogin.mockResolvedValue(mockAdmin);

      const result = await controller.login({
        user: { address: mockAdmin.walletAddress },
      } as AuthenticatedRequest);

      expect(adminService.findByWallet).toHaveBeenCalledWith(
        mockAdmin.walletAddress,
      );
      expect(adminService.recordLogin).toHaveBeenCalledWith(
        mockAdmin.walletAddress,
      );
      expect(result).toEqual({
        authenticated: true,
        admin: {
          id: mockAdmin.id,
          walletAddress: mockAdmin.walletAddress,
          role: mockAdmin.role,
          isActive: mockAdmin.isActive,
        },
      });
    });
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
    it('returns sanitized admin profile', () => {
      const profile = controller.getProfile(mockAdmin);
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

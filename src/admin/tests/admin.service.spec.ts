import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminService } from '../admin.service';
import { Admin, AdminRole } from '../entities/admin.entity';

describe('AdminService', () => {
  let service: AdminService;
  let repo: jest.Mocked<Repository<Admin>>;

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
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        {
          provide: getRepositoryToken(Admin),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            findOneBy: jest.fn(),
            findAndCount: jest.fn(),
            count: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
    repo = module.get<Repository<Admin>>(getRepositoryToken(Admin)) as jest.Mocked<Repository<Admin>>;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create a new admin', async () => {
      repo.findOne.mockResolvedValue(null);
      repo.create.mockReturnValue(mockAdmin);
      repo.save.mockResolvedValue(mockAdmin);

      const result = await service.create(
        { walletAddress: '0x123', role: AdminRole.ADMINISTRATOR },
        mockSuperAdmin,
      );

      expect(repo.create).toHaveBeenCalledWith({
        walletAddress: '0x123',
        role: AdminRole.ADMINISTRATOR,
        isActive: true,
      });
      expect(repo.save).toHaveBeenCalled();
      expect(result).toEqual(mockAdmin);
    });

    it('should throw ConflictException if admin already exists', async () => {
      repo.findOne.mockResolvedValue(mockAdmin);

      await expect(
        service.create(
          { walletAddress: '0x123', role: AdminRole.MODERATOR },
          mockSuperAdmin,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw ForbiddenException if non-admin tries to create admin', async () => {
      const auditor: Admin = { ...mockAdmin, role: AdminRole.AUDITOR };

      await expect(
        service.create(
          { walletAddress: '0x456', role: AdminRole.MODERATOR },
          auditor,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('findAll', () => {
    it('should return paginated admins', async () => {
      repo.findAndCount.mockResolvedValue([[mockAdmin], 1]);

      const result = await service.findAll(1, 20);

      expect(repo.findAndCount).toHaveBeenCalledWith({
        skip: 0,
        take: 20,
        order: { createdAt: 'DESC' },
      });
      expect(result.data).toEqual([mockAdmin]);
      expect(result.total).toBe(1);
    });
  });

  describe('findById', () => {
    it('should return admin by ID', async () => {
      repo.findOneBy.mockResolvedValue(mockAdmin);

      const result = await service.findById('admin-1');

      expect(result).toEqual(mockAdmin);
    });

    it('should throw NotFoundException if admin not found', async () => {
      repo.findOneBy.mockResolvedValue(null);

      await expect(service.findById('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findByWallet', () => {
    it('should return admin by wallet address', async () => {
      repo.findOne.mockResolvedValue(mockAdmin);

      const result = await service.findByWallet('0x123');

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { walletAddress: '0x123', isActive: true },
      });
      expect(result).toEqual(mockAdmin);
    });

    it('should return null if admin not found', async () => {
      repo.findOne.mockResolvedValue(null);

      const result = await service.findByWallet('0x999');

      expect(result).toBeNull();
    });
  });

  describe('updateRole', () => {
    it('should update admin role', async () => {
      repo.findOneBy.mockResolvedValue(mockAdmin);
      repo.save.mockResolvedValue({ ...mockAdmin, role: AdminRole.MODERATOR });

      const result = await service.updateRole(
        'admin-1',
        { role: AdminRole.MODERATOR },
        mockSuperAdmin,
      );

      expect(result.role).toBe(AdminRole.MODERATOR);
    });

    it('should throw ForbiddenException when auditor tries to update role', async () => {
      const auditor: Admin = { ...mockAdmin, role: AdminRole.AUDITOR };

      await expect(
        service.updateRole('admin-1', { role: AdminRole.MODERATOR }, auditor),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('updateStatus', () => {
    it('should activate/deactivate admin', async () => {
      repo.findOneBy.mockResolvedValue(mockAdmin);
      repo.save.mockResolvedValue({ ...mockAdmin, isActive: false });

      const result = await service.updateStatus(
        'admin-1',
        { isActive: false },
        mockSuperAdmin,
      );

      expect(result.isActive).toBe(false);
    });
  });

  describe('recordLogin', () => {
    it('should update lastLoginAt', async () => {
      repo.findOne.mockResolvedValue(mockAdmin);
      repo.save.mockResolvedValue({ ...mockAdmin, lastLoginAt: new Date() });

      const result = await service.recordLogin('0x123');

      expect(result.lastLoginAt).toBeInstanceOf(Date);
    });

    it('should throw NotFoundException if admin not found', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.recordLogin('0x999')).rejects.toThrow(NotFoundException);
    });
  });
});

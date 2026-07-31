import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Repository } from 'typeorm';
import { AdminGuard } from '../guards/admin.guard';
import { Admin, AdminRole } from '../entities/admin.entity';

describe('AdminGuard', () => {
  let guard: AdminGuard;
  let adminRepo: jest.Mocked<Repository<Admin>>;
  let reflector: jest.Mocked<Reflector>;

  const mockContext = (user?: any) => {
    const handler = () => {};
    const cls = class {};
    return {
      getHandler: () => handler,
      getClass: () => cls,
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    } as any;
  };

  beforeEach(() => {
    adminRepo = {
      findOne: jest.fn(),
    } as any;
    reflector = {} as any;
    guard = new AdminGuard(adminRepo, reflector);
  });

  it('should allow access for active admin', async () => {
    const admin: Admin = {
      id: 'admin-1',
      walletAddress: '0xabc',
      role: AdminRole.ADMINISTRATOR,
      isActive: true,
      permissions: null,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    adminRepo.findOne.mockResolvedValue(admin);

    const context = mockContext({ address: '0xabc' });
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(context.switchToHttp().getRequest().admin).toEqual(admin);
  });

  it('should throw UnauthorizedException if no user in request', async () => {
    await expect(guard.canActivate(mockContext(undefined))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should throw UnauthorizedException if no wallet address', async () => {
    await expect(guard.canActivate(mockContext({}))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('should throw ForbiddenException if admin not found', async () => {
    adminRepo.findOne.mockResolvedValue(null);

    await expect(
      guard.canActivate(mockContext({ address: '0x999' })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('should throw ForbiddenException if admin is inactive', async () => {
    adminRepo.findOne.mockResolvedValue(null);

    await expect(
      guard.canActivate(mockContext({ address: '0x999' })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('should handle user with walletAddress field', async () => {
    const admin: Admin = {
      id: 'admin-1',
      walletAddress: '0xabc',
      role: AdminRole.ADMINISTRATOR,
      isActive: true,
      permissions: null,
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    adminRepo.findOne.mockResolvedValue(admin);

    const context = mockContext({ walletAddress: '0xabc' });
    const result = await guard.canActivate(context);

    expect(result).toBe(true);
  });
});

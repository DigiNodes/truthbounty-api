import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ForbiddenException } from '@nestjs/common';
import { AdminService } from '../admin.service';
import { Admin, AdminRole } from '../entities/admin.entity';
import {
  ADMIN_ROLE_GRANT_POLICY,
  canGrantAdminRole,
  canModifyAdminAccount,
} from '../admin.policy';
import { AuditTrailService } from '../../audit/services/audit-trail.service';
import {
  AuditActionType,
  AuditCategory,
  AuditSeverity,
} from '../../audit/entities/audit-log.entity';

describe('PREWAVE-BE-135: Admin Role Grant Policy & Privilege Escalation Prevention', () => {
  let service: AdminService;
  let adminRepo: jest.Mocked<Repository<Admin>>;
  let auditTrailService: { log: jest.Mock };

  const allRoles: AdminRole[] = [
    AdminRole.SUPER_ADMIN,
    AdminRole.ADMINISTRATOR,
    AdminRole.SECURITY_ANALYST,
    AdminRole.GOVERNANCE_OPERATOR,
    AdminRole.MODERATOR,
    AdminRole.AUDITOR,
  ];

  const buildAdmin = (role: AdminRole, id = `admin-${role}`): Admin => ({
    id,
    walletAddress: `0x${role.toLowerCase().replace('_', '')}00000000000000000000000000000000`,
    role,
    isActive: true,
    permissions: null,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  beforeEach(async () => {
    auditTrailService = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminService,
        {
          provide: getRepositoryToken(Admin),
          useValue: {
            create: jest.fn((dto) => ({ ...dto, id: 'created-id' })),
            save: jest.fn((entity) =>
              Promise.resolve({ ...entity, id: entity.id || 'saved-id' }),
            ),
            findOne: jest.fn(),
            findOneBy: jest.fn(),
            findAndCount: jest.fn(),
            count: jest.fn(),
          },
        },
        {
          provide: AuditTrailService,
          useValue: auditTrailService,
        },
      ],
    }).compile();

    service = module.get<AdminService>(AdminService);
    adminRepo = module.get(getRepositoryToken(Admin));
  });

  describe('Explicit Role-Grant Policy Matrix', () => {
    it('SUPER_ADMIN can grant all admin-operator roles', () => {
      for (const targetRole of allRoles) {
        expect(canGrantAdminRole(AdminRole.SUPER_ADMIN, targetRole)).toBe(true);
      }
    });

    it('ADMINISTRATOR cannot grant or promote to SUPER_ADMIN', () => {
      expect(
        canGrantAdminRole(AdminRole.ADMINISTRATOR, AdminRole.SUPER_ADMIN),
      ).toBe(false);
    });

    it('ADMINISTRATOR can grant operator roles at or below its own level', () => {
      const allowedRoles = [
        AdminRole.ADMINISTRATOR,
        AdminRole.SECURITY_ANALYST,
        AdminRole.GOVERNANCE_OPERATOR,
        AdminRole.MODERATOR,
        AdminRole.AUDITOR,
      ];
      for (const targetRole of allowedRoles) {
        expect(canGrantAdminRole(AdminRole.ADMINISTRATOR, targetRole)).toBe(
          true,
        );
      }
    });

    it('non-admin operators have empty grant authority', () => {
      const nonAdminRoles = [
        AdminRole.SECURITY_ANALYST,
        AdminRole.GOVERNANCE_OPERATOR,
        AdminRole.MODERATOR,
        AdminRole.AUDITOR,
      ];
      for (const actorRole of nonAdminRoles) {
        expect(ADMIN_ROLE_GRANT_POLICY[actorRole]).toEqual([]);
        for (const targetRole of allRoles) {
          expect(canGrantAdminRole(actorRole, targetRole)).toBe(false);
        }
      }
    });

    it('canModifyAdminAccount protects SUPER_ADMIN from non-SUPER_ADMIN modification', () => {
      expect(
        canModifyAdminAccount(AdminRole.SUPER_ADMIN, AdminRole.SUPER_ADMIN),
      ).toBe(true);
      expect(
        canModifyAdminAccount(AdminRole.ADMINISTRATOR, AdminRole.SUPER_ADMIN),
      ).toBe(false);
      expect(
        canModifyAdminAccount(AdminRole.MODERATOR, AdminRole.SUPER_ADMIN),
      ).toBe(false);
      expect(
        canModifyAdminAccount(AdminRole.AUDITOR, AdminRole.SUPER_ADMIN),
      ).toBe(false);
    });

    it('canModifyAdminAccount allows SUPER_ADMIN and ADMINISTRATOR to manage non-SUPER_ADMINs', () => {
      for (const targetRole of allRoles.filter(
        (r) => r !== AdminRole.SUPER_ADMIN,
      )) {
        expect(canModifyAdminAccount(AdminRole.SUPER_ADMIN, targetRole)).toBe(
          true,
        );
        expect(canModifyAdminAccount(AdminRole.ADMINISTRATOR, targetRole)).toBe(
          true,
        );
        expect(canModifyAdminAccount(AdminRole.MODERATOR, targetRole)).toBe(
          false,
        );
        expect(canModifyAdminAccount(AdminRole.AUDITOR, targetRole)).toBe(
          false,
        );
      }
    });
  });

  describe('Exhaustive Actor x Target Role Matrix: AdminService.create()', () => {
    for (const actorRole of allRoles) {
      for (const targetRole of allRoles) {
        const actor = buildAdmin(actorRole);

        if (actorRole === AdminRole.SUPER_ADMIN) {
          it(`SUPER_ADMIN creating role "${targetRole}" should SUCCEED`, async () => {
            adminRepo.findOne.mockResolvedValue(null);
            const res = await service.create(
              { walletAddress: '0x123', role: targetRole },
              actor,
            );
            expect(res.role).toBe(targetRole);
            expect(adminRepo.save).toHaveBeenCalled();
            expect(auditTrailService.log).toHaveBeenCalledWith(
              expect.objectContaining({
                actionType: AuditActionType.ROLE_ASSIGNED,
                category: AuditCategory.ADMINISTRATIVE,
                metadata: expect.objectContaining({
                  actorRole: AdminRole.SUPER_ADMIN,
                  newRole: targetRole,
                  outcome: 'success',
                }),
              }),
            );
          });
        } else if (actorRole === AdminRole.ADMINISTRATOR) {
          if (targetRole === AdminRole.SUPER_ADMIN) {
            it(`ADMINISTRATOR creating role "SUPER_ADMIN" must FAIL (ForbiddenException)`, async () => {
              adminRepo.findOne.mockResolvedValue(null);
              await expect(
                service.create(
                  { walletAddress: '0x123', role: targetRole },
                  actor,
                ),
              ).rejects.toThrow(ForbiddenException);
              expect(adminRepo.save).not.toHaveBeenCalled();
              expect(auditTrailService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                  actionType: AuditActionType.ROLE_ASSIGNED,
                  category: AuditCategory.SECURITY,
                  severity: AuditSeverity.CRITICAL,
                  metadata: expect.objectContaining({
                    actorRole: AdminRole.ADMINISTRATOR,
                    newRole: AdminRole.SUPER_ADMIN,
                    outcome: 'denied',
                  }),
                }),
              );
            });
          } else {
            it(`ADMINISTRATOR creating permitted role "${targetRole}" should SUCCEED`, async () => {
              adminRepo.findOne.mockResolvedValue(null);
              const res = await service.create(
                { walletAddress: '0x123', role: targetRole },
                actor,
              );
              expect(res.role).toBe(targetRole);
              expect(adminRepo.save).toHaveBeenCalled();
              expect(auditTrailService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                  metadata: expect.objectContaining({
                    actorRole: AdminRole.ADMINISTRATOR,
                    newRole: targetRole,
                    outcome: 'success',
                  }),
                }),
              );
            });
          }
        } else {
          it(`Non-admin role "${actorRole}" creating role "${targetRole}" must FAIL (ForbiddenException)`, async () => {
            await expect(
              service.create(
                { walletAddress: '0x123', role: targetRole },
                actor,
              ),
            ).rejects.toThrow(ForbiddenException);
            expect(adminRepo.save).not.toHaveBeenCalled();
            expect(auditTrailService.log).toHaveBeenCalledWith(
              expect.objectContaining({
                category: AuditCategory.SECURITY,
                metadata: expect.objectContaining({
                  actorRole,
                  outcome: 'denied',
                }),
              }),
            );
          });
        }
      }
    }
  });

  describe('Exhaustive Actor x Target Role Matrix: AdminService.updateRole()', () => {
    for (const actorRole of allRoles) {
      for (const targetRole of allRoles) {
        const actor = buildAdmin(actorRole);
        const targetModerator = buildAdmin(AdminRole.MODERATOR, 'target-mod');

        if (actorRole === AdminRole.SUPER_ADMIN) {
          it(`SUPER_ADMIN promoting target to "${targetRole}" should SUCCEED`, async () => {
            adminRepo.findOneBy.mockResolvedValue({ ...targetModerator });
            const res = await service.updateRole(
              'target-mod',
              { role: targetRole },
              actor,
            );
            expect(res.role).toBe(targetRole);
            expect(adminRepo.save).toHaveBeenCalled();
            expect(auditTrailService.log).toHaveBeenCalledWith(
              expect.objectContaining({
                actionType: AuditActionType.ROLE_ASSIGNED,
                metadata: expect.objectContaining({
                  actorRole: AdminRole.SUPER_ADMIN,
                  previousRole: AdminRole.MODERATOR,
                  newRole: targetRole,
                  outcome: 'success',
                }),
              }),
            );
          });
        } else if (actorRole === AdminRole.ADMINISTRATOR) {
          if (targetRole === AdminRole.SUPER_ADMIN) {
            it(`ADMINISTRATOR promoting target to "SUPER_ADMIN" must FAIL (ForbiddenException)`, async () => {
              adminRepo.findOneBy.mockResolvedValue({ ...targetModerator });
              await expect(
                service.updateRole('target-mod', { role: targetRole }, actor),
              ).rejects.toThrow(ForbiddenException);
              expect(adminRepo.save).not.toHaveBeenCalled();
              expect(auditTrailService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                  category: AuditCategory.SECURITY,
                  severity: AuditSeverity.CRITICAL,
                  metadata: expect.objectContaining({
                    actorRole: AdminRole.ADMINISTRATOR,
                    newRole: AdminRole.SUPER_ADMIN,
                    outcome: 'denied',
                  }),
                }),
              );
            });
          } else {
            it(`ADMINISTRATOR updating target to permitted role "${targetRole}" should SUCCEED`, async () => {
              adminRepo.findOneBy.mockResolvedValue({ ...targetModerator });
              const res = await service.updateRole(
                'target-mod',
                { role: targetRole },
                actor,
              );
              expect(res.role).toBe(targetRole);
              expect(adminRepo.save).toHaveBeenCalled();
            });
          }
        } else {
          it(`Non-admin role "${actorRole}" attempting to update role to "${targetRole}" must FAIL`, async () => {
            await expect(
              service.updateRole('target-mod', { role: targetRole }, actor),
            ).rejects.toThrow(ForbiddenException);
            expect(adminRepo.save).not.toHaveBeenCalled();
            expect(auditTrailService.log).toHaveBeenCalledWith(
              expect.objectContaining({
                category: AuditCategory.SECURITY,
                metadata: expect.objectContaining({
                  actorRole,
                  outcome: 'denied',
                }),
              }),
            );
          });
        }
      }
    }
  });

  describe('Protection of Existing SUPER_ADMIN accounts', () => {
    const superAdminTarget = buildAdmin(AdminRole.SUPER_ADMIN, 'super-target');
    const adminCaller = buildAdmin(AdminRole.ADMINISTRATOR, 'admin-caller');
    const superCaller = buildAdmin(AdminRole.SUPER_ADMIN, 'super-caller');

    it('ADMINISTRATOR cannot alter existing SUPER_ADMIN role (demote or change)', async () => {
      adminRepo.findOneBy.mockResolvedValue({ ...superAdminTarget });
      await expect(
        service.updateRole(
          'super-target',
          { role: AdminRole.MODERATOR },
          adminCaller,
        ),
      ).rejects.toThrow(new ForbiddenException('Cannot modify a super admin'));

      expect(adminRepo.save).not.toHaveBeenCalled();
      expect(auditTrailService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          category: AuditCategory.SECURITY,
          severity: AuditSeverity.CRITICAL,
          metadata: expect.objectContaining({
            actorRole: AdminRole.ADMINISTRATOR,
            previousRole: AdminRole.SUPER_ADMIN,
            outcome: 'denied',
          }),
        }),
      );
    });

    it('ADMINISTRATOR cannot alter existing SUPER_ADMIN active status', async () => {
      adminRepo.findOneBy.mockResolvedValue({ ...superAdminTarget });
      await expect(
        service.updateStatus('super-target', { isActive: false }, adminCaller),
      ).rejects.toThrow(new ForbiddenException('Cannot modify a super admin'));

      expect(adminRepo.save).not.toHaveBeenCalled();
      expect(auditTrailService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          category: AuditCategory.SECURITY,
          severity: AuditSeverity.CRITICAL,
          metadata: expect.objectContaining({
            actorRole: AdminRole.ADMINISTRATOR,
            outcome: 'denied',
          }),
        }),
      );
    });

    it('SUPER_ADMIN can alter SUPER_ADMIN account role within approved policy', async () => {
      adminRepo.findOneBy.mockResolvedValue({ ...superAdminTarget });
      const res = await service.updateRole(
        'super-target',
        { role: AdminRole.ADMINISTRATOR },
        superCaller,
      );
      expect(res.role).toBe(AdminRole.ADMINISTRATOR);
      expect(adminRepo.save).toHaveBeenCalled();
    });

    it('SUPER_ADMIN can alter SUPER_ADMIN account status', async () => {
      adminRepo.findOneBy.mockResolvedValue({ ...superAdminTarget });
      const res = await service.updateStatus(
        'super-target',
        { isActive: false },
        superCaller,
      );
      expect(res.isActive).toBe(false);
      expect(adminRepo.save).toHaveBeenCalled();
    });
  });

  describe('Least-privilege creation defaults', () => {
    it('omitting role in create() defaults to AUDITOR (least privilege)', async () => {
      adminRepo.findOne.mockResolvedValue(null);
      const adminCaller = buildAdmin(AdminRole.ADMINISTRATOR);

      const res = await service.create(
        { walletAddress: '0xdefault-test' },
        adminCaller,
      );

      expect(adminRepo.create).toHaveBeenCalledWith({
        walletAddress: '0xdefault-test',
        role: AdminRole.AUDITOR,
        isActive: true,
      });
      expect(res.role).toBe(AdminRole.AUDITOR);
    });
  });

  describe('Direct Service Invocation Security', () => {
    it('calling service directly without controller guards enforces grant policy', async () => {
      const adminCaller = buildAdmin(AdminRole.ADMINISTRATOR);

      // Direct method invocation with forged/unauthorized target role
      await expect(
        service.create(
          { walletAddress: '0xbad', role: AdminRole.SUPER_ADMIN },
          adminCaller,
        ),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        service.updateRole(
          'some-id',
          { role: AdminRole.SUPER_ADMIN },
          adminCaller,
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('Concurrency & Transaction Integrity', () => {
    it('transactional execution re-verifies target role before mutation', async () => {
      const mockManager = {
        getRepository: jest.fn().mockReturnValue({
          findOneBy: jest
            .fn()
            .mockResolvedValue(buildAdmin(AdminRole.SUPER_ADMIN, 'target-id')),
          save: jest.fn(),
        }),
      };
      (adminRepo as any).manager = {
        transaction: jest.fn((work) => work(mockManager)),
      };

      const adminCaller = buildAdmin(AdminRole.ADMINISTRATOR);

      // Target was concurrently promoted to SUPER_ADMIN before this transaction commits
      await expect(
        service.updateRole(
          'target-id',
          { role: AdminRole.AUDITOR },
          adminCaller,
        ),
      ).rejects.toThrow(new ForbiddenException('Cannot modify a super admin'));

      expect(mockManager.getRepository().save).not.toHaveBeenCalled();
    });
  });
});

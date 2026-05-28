import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditTrailService } from './audit-trail.service';
import { AuditLog } from '../entities/audit-log.entity';
import { Repository } from 'typeorm';
import { REQUEST } from '@nestjs/core';
import { AuditActionType, AuditEntityType } from '../entities/audit-log.entity';

describe('AuditTrailService - IP Security', () => {
  let service: AuditTrailService;
  let repository: any;
  let mockRequest: any;

  beforeEach(async () => {
    mockRequest = {
      headers: {},
      ip: undefined,
      socket: { remoteAddress: undefined },
      get: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditTrailService,
        {
          provide: getRepositoryToken(AuditLog),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            find: jest.fn(),
            findAndCount: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
        {
          provide: REQUEST,
          useValue: mockRequest,
        },
      ],
    }).compile();

    service = module.get<AuditTrailService>(AuditTrailService);
    repository = module.get(getRepositoryToken(AuditLog));
  });

  describe(' getClientIp() - IP Spoofing Protection', () => {
    it('should ignore x-forwarded-for from untrusted clients when trust proxy is false', async () => {
      // Simulate direct connection with spoofed x-forwarded-for
      mockRequest.headers['x-forwarded-for'] = '192.168.1.100';
      mockRequest.headers['x-real-ip'] = '10.0.0.1';
      mockRequest.socket.remoteAddress = '203.0.113.45'; // Real client IP
      mockRequest.ip = '203.0.113.45'; // Express sets this when trust proxy is false

      const auditInput = {
        actionType: AuditActionType.CLAIM_CREATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'test-123',
        description: 'Test audit log',
      };

      repository.create.mockReturnValue({
        ...auditInput,
        ipAddress: '203.0.113.45',
      });
      repository.save.mockResolvedValue({ id: 'audit-1' });

      await service.log(auditInput);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '203.0.113.45', // Should use real IP, not spoofed header
        }),
      );
    });

    it('should use req.ip when trust proxy is properly configured', async () => {
      // Simulate trusted proxy scenario
      mockRequest.headers['x-forwarded-for'] = '203.0.113.45';
      mockRequest.ip = '203.0.113.45'; // Express sets this to trusted forwarded IP
      mockRequest.socket.remoteAddress = '127.0.0.1'; // Proxy IP

      const auditInput = {
        actionType: AuditActionType.CLAIM_UPDATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'test-456',
        description: 'Test update',
      };

      repository.create.mockReturnValue({
        ...auditInput,
        ipAddress: '203.0.113.45',
      });
      repository.save.mockResolvedValue({ id: 'audit-2' });

      await service.log(auditInput);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '203.0.113.45', // Should use trusted forwarded IP
        }),
      );
    });

    it('should fall back to socket.remoteAddress when req.ip is undefined', async () => {
      mockRequest.ip = undefined;
      mockRequest.socket.remoteAddress = '198.51.100.23';
      mockRequest.headers['x-forwarded-for'] = '1.2.3.4'; // Should be ignored

      const auditInput = {
        actionType: AuditActionType.EVIDENCE_FLAGGED,
        entityType: AuditEntityType.EVIDENCE,
        entityId: 'test-789',
        description: 'Test delete',
      };

      repository.create.mockReturnValue({
        ...auditInput,
        ipAddress: '198.51.100.23',
      });
      repository.save.mockResolvedValue({ id: 'audit-3' });

      await service.log(auditInput);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '198.51.100.23', // Should fall back to socket address
        }),
      );
    });

    it('should return undefined when no request object is available', async () => {
      // Test with null request
      const moduleWithoutRequest: TestingModule =
        await Test.createTestingModule({
          providers: [
            AuditTrailService,
            {
              provide: getRepositoryToken(AuditLog),
              useValue: {
                create: jest.fn(),
                save: jest.fn(),
                find: jest.fn(),
                findAndCount: jest.fn(),
                createQueryBuilder: jest.fn(),
              },
            },
            {
              provide: REQUEST,
              useValue: null,
            },
          ],
        }).compile();

      const serviceWithoutRequest =
        moduleWithoutRequest.get<AuditTrailService>(AuditTrailService);
      const innerRepo = moduleWithoutRequest.get(getRepositoryToken(AuditLog)) as any;

      const auditInput = {
        actionType: AuditActionType.CLAIM_CREATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'test-no-request',
        description: 'Test without request',
      };

      innerRepo.create.mockReturnValue({
        ...auditInput,
        ipAddress: undefined,
      });
      innerRepo.save.mockResolvedValue({ id: 'audit-4' });

      await serviceWithoutRequest.log(auditInput);

      expect(innerRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: undefined,
        }),
      );
    });

    it('should handle multiple IP addresses in x-forwarded-for correctly when trusted', async () => {
      // Simulate chain of proxies: client -> proxy1 -> proxy2 -> server
      mockRequest.headers['x-forwarded-for'] =
        '203.0.113.45, 192.168.1.1, 10.0.0.1';
      mockRequest.ip = '203.0.113.45'; // Express extracts the leftmost (original client) IP
      mockRequest.socket.remoteAddress = '127.0.0.1'; // Last proxy

      const auditInput = {
        actionType: AuditActionType.CLAIM_CREATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'test-multi-ip',
        description: 'Test multi IP',
      };

      repository.create.mockReturnValue({
        ...auditInput,
        ipAddress: '203.0.113.45',
      });
      repository.save.mockResolvedValue({ id: 'audit-5' });

      await service.log(auditInput);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '203.0.113.45', // Should use the original client IP
        }),
      );
    });
  });

  describe('IP Spoofing Attack Scenarios', () => {
    it('should prevent basic IP spoofing attack', async () => {
      // Attacker tries to spoof their IP as a legitimate address
      mockRequest.headers['x-forwarded-for'] = '8.8.8.8'; // Google DNS - trying to look legitimate
      mockRequest.socket.remoteAddress = '203.0.113.45'; // Attacker's real IP
      mockRequest.ip = '203.0.113.45'; // Express uses real IP when trust proxy is false

      const auditInput = {
        actionType: AuditActionType.CLAIM_CREATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'attack-1',
        description: 'Malicious activity attempt',
      };

      repository.create.mockReturnValue({
        ...auditInput,
        ipAddress: '203.0.113.45',
      });
      repository.save.mockResolvedValue({ id: 'audit-attack-1' });

      await service.log(auditInput);

      // Verify the real IP is logged, not the spoofed one
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '203.0.113.45', // Real attacker IP, not 8.8.8.8
        }),
      );
    });

    it('should prevent CF-Connecting-IP spoofing', async () => {
      // Attacker tries to spoof Cloudflare IP header
      mockRequest.headers['cf-connecting-ip'] = '1.1.1.1'; // Cloudflare DNS
      mockRequest.headers['x-forwarded-for'] = '8.8.8.8';
      mockRequest.socket.remoteAddress = '203.0.113.45';
      mockRequest.ip = '203.0.113.45';

      const auditInput = {
        actionType: AuditActionType.CLAIM_UPDATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'attack-2',
        description: 'CF IP spoof attempt',
      };

      repository.create.mockReturnValue({
        ...auditInput,
        ipAddress: '203.0.113.45',
      });
      repository.save.mockResolvedValue({ id: 'audit-attack-2' });

      await service.log(auditInput);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '203.0.113.45', // Real IP, not spoofed CF header
        }),
      );
    });
  });
});

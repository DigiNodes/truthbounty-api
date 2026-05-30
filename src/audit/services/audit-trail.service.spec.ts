/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuditTrailService } from './audit-trail.service';
import { AuditLog } from '../entities/audit-log.entity';
import { Repository } from 'typeorm';
import { REQUEST } from '@nestjs/core';
import { AuditActionType, AuditEntityType } from '../entities/audit-log.entity';
import { maskIp } from '../utils/ip-masking';

interface MockRequestType {
  headers: Record<string, string>;
  ip: string | undefined;
  socket: { remoteAddress: string | undefined };
  get: jest.Mock<string | undefined, [string]>;
}

describe('AuditTrailService - IP Security and Masking', () => {
  let service: AuditTrailService;
  let repository: jest.Mocked<Repository<AuditLog>>;
  let mockRequest: MockRequestType;

  beforeEach(async () => {
    mockRequest = {
      headers: {},
      ip: undefined,
      socket: { remoteAddress: undefined },
      get: jest.fn<string | undefined, [string]>(),
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
    repository = module.get<Repository<AuditLog>>(
      getRepositoryToken(AuditLog),
    ) as jest.Mocked<Repository<AuditLog>>;
  });

  describe('getClientIp() - IP Spoofing Protection and Masking', () => {
    it('should ignore x-forwarded-for from untrusted clients when trust proxy is false and return masked IP', async () => {
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

      (repository.create as jest.Mock).mockReturnValue({
        ...auditInput,
        ipAddress: '203.0.113.0',
      });
      (repository.save as jest.Mock).mockResolvedValue({ id: 'audit-1' });

      await service.log(auditInput);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '203.0.113.0', // Should use real IP masked, not spoofed header
        }),
      );
    });

    it('should use req.ip when trust proxy is properly configured and return masked IP', async () => {
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

      (repository.create as jest.Mock).mockReturnValue({
        ...auditInput,
        ipAddress: '203.0.113.0',
      });
      (repository.save as jest.Mock).mockResolvedValue({ id: 'audit-2' });

      await service.log(auditInput);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '203.0.113.0', // Should use trusted forwarded IP masked
        }),
      );
    });

    it('should fall back to socket.remoteAddress when req.ip is undefined and return masked IP', async () => {
      mockRequest.ip = undefined;
      mockRequest.socket.remoteAddress = '198.51.100.23';
      mockRequest.headers['x-forwarded-for'] = '1.2.3.4'; // Should be ignored

      const auditInput = {
        actionType: AuditActionType.EVIDENCE_FLAGGED,
        entityType: AuditEntityType.EVIDENCE,
        entityId: 'test-789',
        description: 'Test delete',
      };

      (repository.create as jest.Mock).mockReturnValue({
        ...auditInput,
        ipAddress: '198.51.100.0',
      });
      (repository.save as jest.Mock).mockResolvedValue({ id: 'audit-3' });

      await service.log(auditInput);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '198.51.100.0', // Should fall back to socket address masked
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
      const tempRepository = moduleWithoutRequest.get<Repository<AuditLog>>(
        getRepositoryToken(AuditLog),
      ) as jest.Mocked<Repository<AuditLog>>;

      const auditInput = {
        actionType: AuditActionType.CLAIM_CREATED,
        entityType: AuditEntityType.CLAIM,
        entityId: 'test-no-request',
        description: 'Test without request',
      };

      (tempRepository.create as jest.Mock).mockReturnValue({
        ...auditInput,
        ipAddress: undefined,
      });
      (tempRepository.save as jest.Mock).mockResolvedValue({ id: 'audit-4' });

      await serviceWithoutRequest.log(auditInput);

      expect(tempRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: undefined,
        }),
      );
    });

    it('should handle multiple IP addresses in x-forwarded-for correctly when trusted and return masked IP', async () => {
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

      (repository.create as jest.Mock).mockReturnValue({
        ...auditInput,
        ipAddress: '203.0.113.0',
      });
      (repository.save as jest.Mock).mockResolvedValue({ id: 'audit-5' });

      await service.log(auditInput);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '203.0.113.0', // Should use the original client IP masked
        }),
      );
    });
  });

  describe('IP Spoofing Attack Scenarios (Masked Results)', () => {
    it('should prevent basic IP spoofing attack and store masked IP', async () => {
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

      (repository.create as jest.Mock).mockReturnValue({
        ...auditInput,
        ipAddress: '203.0.113.0',
      });
      (repository.save as jest.Mock).mockResolvedValue({
        id: 'audit-attack-1',
      });

      await service.log(auditInput);

      // Verify the real IP is logged (masked), not the spoofed one
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '203.0.113.0', // Real attacker IP masked, not 8.8.8.8
        }),
      );
    });

    it('should prevent CF-Connecting-IP spoofing and store masked IP', async () => {
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

      (repository.create as jest.Mock).mockReturnValue({
        ...auditInput,
        ipAddress: '203.0.113.0',
      });
      (repository.save as jest.Mock).mockResolvedValue({
        id: 'audit-attack-2',
      });

      await service.log(auditInput);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: '203.0.113.0', // Real IP masked, not spoofed CF header
        }),
      );
    });
  });

  describe('maskIp utility', () => {
    it('should handle undefined and empty values', () => {
      expect(maskIp(undefined)).toBeUndefined();
      expect(maskIp('')).toBeUndefined();
    });

    it('should mask IPv4 addresses by zeroing the last octet', () => {
      expect(maskIp('192.168.1.1')).toBe('192.168.1.0');
      expect(maskIp('203.0.113.45')).toBe('203.0.113.0');
      expect(maskIp('8.8.8.8')).toBe('8.8.8.0');
    });

    it('should handle IPv4 addresses with ports', () => {
      expect(maskIp('192.168.1.1:8080')).toBe('192.168.1.0:8080');
    });

    it('should mask IPv6 addresses by zeroing the last 64 bits', () => {
      expect(maskIp('2001:db8:85a3:8d3:1319:8a2e:370:7334')).toBe(
        '2001:db8:85a3:8d3::',
      );
      expect(maskIp('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8:85a3:0::');
    });

    it('should handle IPv6 loopback and special values', () => {
      expect(maskIp('::1')).toBe('::');
      expect(maskIp('::')).toBe('::');
    });

    it('should mask IPv4-mapped IPv6 addresses', () => {
      expect(maskIp('::ffff:192.168.1.1')).toBe('::ffff:192.168.1.0');
      expect(maskIp('::ffff:203.0.113.45')).toBe('::ffff:203.0.113.0');
    });

    it('should handle bracketed IPv6 and zone indices', () => {
      expect(maskIp('[2001:db8:85a3:8d3:1319:8a2e:370:7334]')).toBe(
        '2001:db8:85a3:8d3::',
      );
      expect(maskIp('fe80::1%eth0')).toBe('fe80:0:0:0::');
    });
  });
});

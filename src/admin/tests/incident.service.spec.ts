import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IncidentService } from '../incidents/incident.service';
import {
  Incident,
  IncidentStatus,
  IncidentSeverity,
  IncidentClassification,
} from '../entities/incident.entity';
import { Admin, AdminRole } from '../entities/admin.entity';
import { AuditTrailService } from '../../audit/services/audit-trail.service';

describe('IncidentService', () => {
  let service: IncidentService;
  let incidentRepo: jest.Mocked<Repository<Incident>>;
  let auditTrailService: jest.Mocked<AuditTrailService>;

  const mockAdmin: Admin = {
    id: 'admin-1',
    walletAddress: '0xabc',
    role: AdminRole.SECURITY_ANALYST,
    isActive: true,
    permissions: null,
    lastLoginAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockIncident: Incident = {
    id: 'inc-1',
    title: 'Security breach detected',
    description: 'Unauthorized access attempt',
    classification: IncidentClassification.SECURITY_BREACH,
    severity: IncidentSeverity.HIGH,
    status: IncidentStatus.OPEN,
    assignedTo: null,
    reportedBy: 'admin-1',
    relatedEntityType: null,
    relatedEntityId: null,
    investigationNotes: null,
    resolution: null,
    postIncidentReport: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    resolvedAt: null,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IncidentService,
        {
          provide: getRepositoryToken(Incident),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            findOneBy: jest.fn(),
            findAndCount: jest.fn(),
            find: jest.fn(),
            count: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
        {
          provide: AuditTrailService,
          useValue: {
            log: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<IncidentService>(IncidentService);
    incidentRepo = module.get<Repository<Incident>>(
      getRepositoryToken(Incident),
    ) as jest.Mocked<Repository<Incident>>;
    auditTrailService = module.get<AuditTrailService>(
      AuditTrailService,
    ) as jest.Mocked<AuditTrailService>;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create a new incident', async () => {
      incidentRepo.create.mockReturnValue(mockIncident);
      incidentRepo.save.mockResolvedValue(mockIncident);

      const result = await service.create(
        {
          title: 'Security breach detected',
          description: 'Unauthorized access attempt',
          classification: IncidentClassification.SECURITY_BREACH,
          severity: IncidentSeverity.HIGH,
        },
        mockAdmin,
      );

      expect(incidentRepo.create).toHaveBeenCalled();
      expect(incidentRepo.save).toHaveBeenCalled();
      expect(auditTrailService.log).toHaveBeenCalled();
      expect(result).toEqual(mockIncident);
    });
  });

  describe('findById', () => {
    it('should return an incident by ID', async () => {
      incidentRepo.findOneBy.mockResolvedValue(mockIncident);

      const result = await service.findById('inc-1');

      expect(result).toEqual(mockIncident);
    });

    it('should throw NotFoundException if incident not found', async () => {
      incidentRepo.findOneBy.mockResolvedValue(null);

      await expect(service.findById('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('resolve', () => {
    it('should resolve an incident', async () => {
      incidentRepo.findOneBy.mockResolvedValue(mockIncident);
      const resolved = {
        ...mockIncident,
        status: IncidentStatus.RESOLVED,
        resolution: {
          summary: 'Issue fixed',
          actions: ['Patched vulnerability'],
          resolvedBy: 'admin-1',
          resolvedAt: expect.any(String),
        },
        resolvedAt: expect.any(Date),
      };
      incidentRepo.save.mockResolvedValue(resolved);

      const result = await service.resolve(
        'inc-1',
        { summary: 'Issue fixed', actions: ['Patched vulnerability'] },
        mockAdmin,
      );

      expect(result.status).toBe(IncidentStatus.RESOLVED);
      expect(result.resolution).toBeDefined();
      expect(auditTrailService.log).toHaveBeenCalled();
    });
  });

  describe('assign', () => {
    it('should assign an incident to an investigator', async () => {
      incidentRepo.findOneBy.mockResolvedValue(mockIncident);
      incidentRepo.save.mockResolvedValue({
        ...mockIncident,
        assignedTo: 'investigator-1',
        status: IncidentStatus.INVESTIGATING,
      });

      const result = await service.assign('inc-1', 'investigator-1', mockAdmin);

      expect(result.assignedTo).toBe('investigator-1');
      expect(result.status).toBe(IncidentStatus.INVESTIGATING);
    });
  });

  describe('addNote', () => {
    it('should add an investigation note', async () => {
      const incidentWithNote = {
        ...mockIncident,
        investigationNotes: [
          { author: 'admin-1', content: 'Initial analysis', createdAt: expect.any(String) },
        ],
      };
      incidentRepo.findOneBy.mockResolvedValue(incidentWithNote);
      incidentRepo.save.mockResolvedValue(incidentWithNote);

      const result = await service.addNote('inc-1', { content: 'Initial analysis' }, mockAdmin);

      expect(result.investigationNotes).toHaveLength(1);
    });
  });

  describe('update', () => {
    it('should update an incident', async () => {
      incidentRepo.findOneBy.mockResolvedValue(mockIncident);
      const updated = { ...mockIncident, severity: IncidentSeverity.CRITICAL };
      incidentRepo.save.mockResolvedValue(updated);

      const result = await service.update(
        'inc-1',
        { severity: IncidentSeverity.CRITICAL },
        mockAdmin,
      );

      expect(result.severity).toBe(IncidentSeverity.CRITICAL);
    });

    it('should throw ForbiddenException if incident is closed', async () => {
      const closedIncident = { ...mockIncident, status: IncidentStatus.CLOSED };
      incidentRepo.findOneBy.mockResolvedValue(closedIncident);

      await expect(
        service.update('inc-1', { severity: IncidentSeverity.CRITICAL }, mockAdmin),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getStats', () => {
    it('should return incident statistics', async () => {
      incidentRepo.count.mockResolvedValue(5);
      incidentRepo.find.mockResolvedValue([]);

      const mockQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      } as any;
      incidentRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder);

      const stats = await service.getStats();

      expect(stats.total).toBe(5);
      expect(stats.bySeverity).toBeDefined();
      expect(stats.byClassification).toBeDefined();
    });
  });
});

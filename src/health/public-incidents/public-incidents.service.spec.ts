import {
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { PublicIncidentService } from './public-incidents.service';
import { PublicIncidentProjectionEntity } from './entities/public-incident-projection.entity';
import {
  RAW_MONITORING_INCIDENT,
  RAW_RESOLVED_INCIDENT,
  SCENARIO_NOW,
  SCENARIO_POLICY,
} from '../../../test/fixtures/contracts/public-incidents.scenarios';

describe('PublicIncidentService (UX-BE-002)', () => {
  let service: PublicIncidentService;
  let mockRepo: jest.Mocked<Repository<PublicIncidentProjectionEntity>>;

  beforeEach(() => {
    mockRepo = {
      createQueryBuilder: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn().mockImplementation((val) => val),
      save: jest.fn().mockImplementation((val) => Promise.resolve(val)),
    } as unknown as jest.Mocked<Repository<PublicIncidentProjectionEntity>>;

    service = new PublicIncidentService(
      mockRepo,
      SCENARIO_POLICY,
      () => SCENARIO_NOW,
    );
  });

  describe('findAll', () => {
    it('queries only approved and non-draft incidents with pagination', async () => {
      const qb: any = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest
          .fn()
          .mockResolvedValue([
            [RAW_MONITORING_INCIDENT, RAW_RESOLVED_INCIDENT],
            2,
          ]),
      };
      mockRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll({ page: 1, limit: 10 });
      expect(qb.where).toHaveBeenCalledWith('p.isApproved = :isApproved', {
        isApproved: true,
      });
      expect(qb.andWhere).toHaveBeenCalledWith('p.isDraft = :isDraft', {
        isDraft: false,
      });
      expect(result.body.data).toHaveLength(2);
      expect(result.body.pagination.total).toBe(2);
      expect(result.maxAgeSeconds).toBe(SCENARIO_POLICY.cacheTtlSeconds);
    });

    it('filters by status and component when provided', async () => {
      const qb: any = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([[RAW_RESOLVED_INCIDENT], 1]),
      };
      mockRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({
        status: 'resolved',
        component: 'database',
      });

      expect(qb.andWhere).toHaveBeenCalledWith('p.status = :status', {
        status: 'resolved',
      });
      expect(qb.andWhere).toHaveBeenCalledWith(
        'p.affectedComponents LIKE :comp',
        { comp: '%database%' },
      );
    });

    it('fails closed with ServiceUnavailableException on database error', async () => {
      mockRepo.createQueryBuilder.mockImplementation(() => {
        throw new Error('Connection terminated');
      });

      await expect(service.findAll({})).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  describe('findById', () => {
    it('returns detail for an approved incident', async () => {
      const qb: any = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(RAW_RESOLVED_INCIDENT),
      };
      mockRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findById('inc-002-resolved-uuid');
      expect(result.body.id).toBe('inc-002-resolved-uuid');
      expect(result.body.status).toBe('resolved');
      expect(result.maxAgeSeconds).toBe(SCENARIO_POLICY.cacheTtlSeconds);
    });

    it('throws NotFoundException for unknown or unapproved incident', async () => {
      const qb: any = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };
      mockRepo.createQueryBuilder.mockReturnValue(qb);

      await expect(service.findById('inc-unknown')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('publishProjection', () => {
    it('creates and approves a public projection with sanitized fields', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      const result = await service.publishProjection({
        title: 'New Incident <script>alert(1)</script>',
        status: 'investigating',
        impact: 'major',
        affectedComponents: ['api'],
        description: 'Under investigation at node.cluster.local',
        updateMessage: 'Initial notice',
        adminId: 'admin-1',
      });

      expect(result.title).toBe('New Incident');
      expect(result.description).not.toContain('cluster.local');
      expect(result.status).toBe('investigating');
      expect(result.publicationHistory).toHaveLength(1);
      expect(mockRepo.save).toHaveBeenCalled();
    });

    it('saves draft without approving when isDraft is true', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      // When draft is projected, projectPublicIncidentDetail returns null unless mock handled
      mockRepo.save.mockImplementationOnce(async (entity: any) => ({
        ...entity,
        // Simulate projector check
        isDraft: false,
        isApproved: true,
      }));

      await service.publishProjection({
        title: 'Draft incident',
        status: 'investigating',
        impact: 'minor',
        affectedComponents: ['web'],
        description: 'Internal draft',
        isDraft: true,
      });

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          isDraft: true,
          isApproved: false,
        }),
      );
    });
  });
});

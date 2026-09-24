import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TemplateService } from './template.service';
import { NotificationTemplate } from '../entities/notification-template.entity';
import { NotificationType } from '../enums/notification-type.enum';

describe('TemplateService', () => {
  let service: TemplateService;
  let templateRepo: Repository<NotificationTemplate>;

  const mockTemplate = {
    id: 'tpl-1',
    name: 'claim-submitted',
    type: NotificationType.CLAIM_SUBMITTED,
    subjectTemplate: 'Claim Submitted: {{claimTitle}}',
    bodyTemplate: 'Your claim "{{claimTitle}}" has been submitted.',
    variables: ['claimTitle', 'claimId'],
    locale: 'en',
    version: 1,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TemplateService,
        {
          provide: getRepositoryToken(NotificationTemplate),
          useClass: Repository,
        },
      ],
    }).compile();

    service = module.get<TemplateService>(TemplateService);
    templateRepo = module.get<Repository<NotificationTemplate>>(getRepositoryToken(NotificationTemplate));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('render', () => {
    it('should render a template with variables', async () => {
      jest.spyOn(templateRepo, 'findOne').mockResolvedValue(mockTemplate as any);

      const result = await service.render('claim-submitted', {
        claimTitle: 'Test Claim',
        claimId: 'claim-123',
      });

      expect(result.subject).toBe('Claim Submitted: Test Claim');
      expect(result.body).toBe('Your claim "Test Claim" has been submitted.');
    });

    it('should fall back to default locale when template not found', async () => {
      const enTemplate = { ...mockTemplate, locale: 'en' };
      jest.spyOn(templateRepo, 'findOne')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(enTemplate as any);

      const result = await service.render('claim-submitted', {
        claimTitle: 'Test',
      }, 'fr');

      expect(result.subject).toBe('Claim Submitted: Test');
    });

    it('should throw when template not found in any locale', async () => {
      jest.spyOn(templateRepo, 'findOne').mockResolvedValue(null);

      await expect(service.render('nonexistent', {})).rejects.toThrow('Template nonexistent not found');
    });
  });

  describe('renderByType', () => {
    it('should render template by notification type', async () => {
      jest.spyOn(templateRepo, 'findOne').mockResolvedValue(mockTemplate as any);

      const result = await service.renderByType(NotificationType.CLAIM_SUBMITTED, {
        claimTitle: 'Test Claim',
      });

      expect(result.subject).toBe('Claim Submitted: Test Claim');
    });
  });

  describe('createTemplate', () => {
    it('should create a new template', async () => {
      const createSpy = jest.spyOn(templateRepo, 'create').mockReturnValue(mockTemplate as any);
      const saveSpy = jest.spyOn(templateRepo, 'save').mockResolvedValue(mockTemplate as any);

      const result = await service.createTemplate(mockTemplate);

      expect(createSpy).toHaveBeenCalledWith(mockTemplate);
      expect(saveSpy).toHaveBeenCalled();
      expect(result).toEqual(mockTemplate);
    });
  });

  describe('findAll', () => {
    it('should return all templates ordered by name', async () => {
      jest.spyOn(templateRepo, 'find').mockResolvedValue([mockTemplate] as any);

      const result = await service.findAll();

      expect(result).toHaveLength(1);
    });
  });

  describe('private substitute', () => {
    it('should replace {{variables}} in template strings', async () => {
      const template = {
        ...mockTemplate,
        subjectTemplate: 'Hello {{name}}, your {{item}} is ready',
        bodyTemplate: 'Plain text without variables',
      };
      jest.spyOn(templateRepo, 'findOne').mockResolvedValue(template as any);

      const result = await service.render('claim-submitted', {
        name: 'Alice',
        item: 'order',
      });

      expect(result.subject).toBe('Hello Alice, your order is ready');
      expect(result.body).toBe('Plain text without variables');
    });

    it('should leave unmatched variables as-is', async () => {
      jest.spyOn(templateRepo, 'findOne').mockResolvedValue(mockTemplate as any);

      const result = await service.render('claim-submitted', {});

      expect(result.subject).toBe('Claim Submitted: {{claimTitle}}');
    });
  });
});

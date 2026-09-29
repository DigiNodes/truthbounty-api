import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TemplateRenderer } from './template-renderer.service';
import { NotificationTemplate } from '../entities/notification-template.entity';
import { EventType } from '../enums/event-type.enum';
import { DeliveryChannel } from '../interfaces/notification.types';

describe('TemplateRenderer', () => {
  let service: TemplateRenderer;
  let mockTemplateRepository: jest.Mocked<Repository<NotificationTemplate>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TemplateRenderer,
        {
          provide: getRepositoryToken(NotificationTemplate),
          useValue: {
            findOne: jest.fn(),
            save: jest.fn(),
            find: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<TemplateRenderer>(TemplateRenderer);
    mockTemplateRepository = module.get(
      getRepositoryToken(NotificationTemplate),
    ) as jest.Mocked<Repository<NotificationTemplate>>;
  });

  describe('render', () => {
    it('should render template with context variables', async () => {
      const template = {
        bodyTemplate: 'New claim: {{title}} for {{amount}} tokens',
        subjectTemplate: 'Claim: {{title}}',
        active: true,
      };

      mockTemplateRepository.findOne.mockResolvedValue(template as any);

      const context = { title: 'COVID Origins', amount: '5000' };
      const result = await service.render(
        EventType.CLAIM_CREATED,
        DeliveryChannel.EMAIL,
        context,
      );

      expect(result.body).toContain('COVID Origins');
      expect(result.body).toContain('5000 tokens');
      expect(result.subject).toContain('COVID Origins');
    });

    it('should support nested variable access', async () => {
      const template = {
        bodyTemplate: 'User {{user.name}} created claim',
        active: true,
      };

      mockTemplateRepository.findOne.mockResolvedValue(template as any);

      const context = { user: { name: 'Alice', id: '123' } };
      const result = await service.render(
        EventType.CLAIM_CREATED,
        DeliveryChannel.EMAIL,
        context,
      );

      expect(result.body).toContain('Alice');
    });

    it('should use generic template if specific not found', async () => {
      mockTemplateRepository.findOne.mockResolvedValue(null);

      const context = { title: 'Test Claim', amount: '1000' };
      const result = await service.render(
        EventType.CLAIM_CREATED,
        DeliveryChannel.EMAIL,
        context,
      );

      expect(result.body).toBeDefined();
      expect(result.subject).toBeDefined();
    });

    it('should fallback to english if language not found', async () => {
      mockTemplateRepository.findOne.mockResolvedValueOnce(null); // Spanish not found
      mockTemplateRepository.findOne.mockResolvedValueOnce({
        bodyTemplate: 'New claim: {{title}}',
        active: true,
      } as any); // English found

      const context = { title: 'Test' };
      const result = await service.render(
        EventType.CLAIM_CREATED,
        DeliveryChannel.EMAIL,
        context,
        'es',
      );

      expect(result.body).toBeDefined();
    });
  });

  describe('saveTemplate', () => {
    it('should create new template', async () => {
      mockTemplateRepository.findOne.mockResolvedValue(null);
      mockTemplateRepository.save.mockResolvedValue({
        id: 'template-1',
        name: 'claim_created_en',
      } as any);

      const result = await service.saveTemplate(
        EventType.CLAIM_CREATED,
        'en',
        'claim_created_en',
        'Subject: {{title}}',
        'Body: {{description}}',
      );

      expect(result.id).toBe('template-1');
      expect(mockTemplateRepository.save).toHaveBeenCalled();
    });

    it('should update existing template', async () => {
      const existing = {
        id: 'template-1',
        name: 'claim_created_en',
        version: 1,
      };

      mockTemplateRepository.findOne.mockResolvedValue(existing as any);
      mockTemplateRepository.save.mockResolvedValue({
        ...existing,
        version: 2,
      } as any);

      const result = await service.saveTemplate(
        EventType.CLAIM_CREATED,
        'en',
        'claim_created_en',
        'New Subject',
        'New Body',
      );

      expect(mockTemplateRepository.save).toHaveBeenCalled();
    });
  });

  describe('getTemplatesForEvent', () => {
    it('should return all active templates for event type', async () => {
      const templates = [
        { id: '1', locale: 'en', active: true },
        { id: '2', locale: 'es', active: true },
      ];

      mockTemplateRepository.find.mockResolvedValue(templates as any);

      const result = await service.getTemplatesForEvent(EventType.CLAIM_CREATED);

      expect(result).toHaveLength(2);
    });
  });

  describe('HTML escape', () => {
    it('should escape HTML in plaintext templates', async () => {
      const template = {
        bodyTemplate: 'Content: {{content}}',
        active: true,
      };

      mockTemplateRepository.findOne.mockResolvedValue(template as any);

      const context = { content: '<script>alert("xss")</script>' };
      const result = await service.render(
        EventType.CLAIM_CREATED,
        DeliveryChannel.EMAIL,
        context,
      );

      expect(result.html).toContain('&lt;script&gt;');
      expect(result.html).not.toContain('<script>');
    });
  });

  describe('Generic template generation', () => {
    it('should generate appropriate generic template for event type', async () => {
      mockTemplateRepository.findOne.mockResolvedValue(null);

      const result = await service.render(
        EventType.VERIFICATION_COMPLETED,
        DeliveryChannel.EMAIL,
        { claimTitle: 'Test' },
      );

      expect(result.subject).toContain('Verification');
      expect(result.body).toBeDefined();
    });
  });
});

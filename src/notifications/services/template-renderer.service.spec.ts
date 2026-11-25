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

  describe('HTML template interpolation safety', () => {
    const renderWith = async (
      template: Record<string, string>,
      context: Record<string, unknown>,
    ) => {
      mockTemplateRepository.findOne.mockResolvedValue({
        active: true,
        ...template,
      } as any);
      return service.render(
        EventType.CLAIM_CREATED,
        DeliveryChannel.EMAIL,
        context,
      );
    };

    it.each([
      ['<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
      [
        '<img src=x onerror="alert(1)">',
        '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
      ],
      ["' onmouseover='steal()", '&#39; onmouseover=&#39;steal()'],
      [
        '<a href="https://evil.test">Claim reward</a>',
        '&lt;a href=&quot;https://evil.test&quot;&gt;Claim reward&lt;/a&gt;',
      ],
    ])(
      'renders %p as text inside authored markup',
      async (payload, escaped) => {
        const result = await renderWith(
          {
            bodyTemplate: 'Claim: {{title}}',
            htmlTemplate:
              '<p class="claim"><strong>Claim:</strong> {{title}}</p>',
          },
          { title: payload },
        );

        expect(result.html).toBe(
          `<p class="claim"><strong>Claim:</strong> ${escaped}</p>`,
        );
      },
    );

    it('escapes quotes so values cannot break out of attributes', async () => {
      const result = await renderWith(
        {
          bodyTemplate: 'x',
          htmlTemplate: '<span title="{{title}}">{{title}}</span>',
        },
        { title: '" autofocus onfocus="alert(1)' },
      );

      expect(result.html).toBe(
        '<span title="&quot; autofocus onfocus=&quot;alert(1)">&quot; autofocus onfocus=&quot;alert(1)</span>',
      );
    });

    it('escapes nested values', async () => {
      const result = await renderWith(
        { bodyTemplate: 'x', htmlTemplate: '<p>{{claim.title}}</p>' },
        { claim: { title: '<b>bold</b>' } },
      );

      expect(result.html).toBe('<p>&lt;b&gt;bold&lt;/b&gt;</p>');
    });

    it.each([
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      '//evil.test/phish',
    ])('drops unsafe URL %p in href and src attributes', async (url) => {
      const result = await renderWith(
        {
          bodyTemplate: 'x',
          htmlTemplate: '<a href="{{link}}">Open</a><img src=\'{{link}}\'>',
        },
        { link: url },
      );

      expect(result.html).toBe('<a href="">Open</a><img src=\'\'>');
    });

    it('keeps safe absolute and root-relative URLs, escaped for the attribute', async () => {
      const result = await renderWith(
        {
          bodyTemplate: 'x',
          htmlTemplate:
            '<a href="{{link}}">Open</a> <a href={{path}}>Claim</a>',
        },
        {
          link: 'https://truthbounty.io/claims?id=1&tab=votes',
          path: '/claims/1',
        },
      );

      expect(result.html).toBe(
        '<a href="https://truthbounty.io/claims?id=1&amp;tab=votes">Open</a> <a href=/claims/1>Claim</a>',
      );
    });

    it('escapes values placed after an authored URL prefix', async () => {
      const result = await renderWith(
        {
          bodyTemplate: 'x',
          htmlTemplate:
            '<a href="https://truthbounty.io/claims/{{id}}">Open</a>',
        },
        { id: '1"><script>alert(1)</script>' },
      );

      expect(result.html).toBe(
        '<a href="https://truthbounty.io/claims/1&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">Open</a>',
      );
    });

    it('leaves unknown placeholders in place', async () => {
      const result = await renderWith(
        { bodyTemplate: 'x', htmlTemplate: '<p>{{missing}}</p>' },
        {},
      );

      expect(result.html).toBe('<p>{{missing}}</p>');
    });

    it('keeps plaintext, subject and markdown output unchanged', async () => {
      const title = '<b>Bold</b> & "quoted"';
      const result = await renderWith(
        {
          subjectTemplate: 'Claim: {{title}}',
          bodyTemplate: 'Body {{title}}',
          markdownTemplate: '**{{title}}**',
          htmlTemplate: '<p>{{title}}</p>',
        },
        { title },
      );

      expect(result.subject).toBe(`Claim: ${title}`);
      expect(result.title).toBe(`Claim: ${title}`);
      expect(result.body).toBe(`Body ${title}`);
      expect(result.markdown).toBe(`**${title}**`);
      expect(result.html).toBe(
        '<p>&lt;b&gt;Bold&lt;/b&gt; &amp; &quot;quoted&quot;</p>',
      );
    });

    it.each([
      ['https://truthbounty.io/claims/1', 'https://truthbounty.io/claims/1'],
      ['/claims/1', '/claims/1'],
      ['mailto:support@truthbounty.io', 'mailto:support@truthbounty.io'],
      ['javascript:alert(1)', undefined],
      ['data:text/html,<script>alert(1)</script>', undefined],
      [42, undefined],
    ])('validates actionUrl %p', async (actionUrl, expected) => {
      const stored = await renderWith({ bodyTemplate: 'x' }, { actionUrl });
      mockTemplateRepository.findOne.mockResolvedValue(null);
      const generic = await service.render(
        EventType.CLAIM_CREATED,
        DeliveryChannel.EMAIL,
        { actionUrl },
      );

      expect(stored.actionUrl).toBe(expected);
      expect(generic.actionUrl).toBe(expected);
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

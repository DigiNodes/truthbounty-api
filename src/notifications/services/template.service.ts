import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationTemplate } from '../entities/notification-template.entity';
import { NotificationType } from '../enums/notification-type.enum';

@Injectable()
export class TemplateService {
  private readonly logger = new Logger(TemplateService.name);

  constructor(
    @InjectRepository(NotificationTemplate)
    private readonly templateRepo: Repository<NotificationTemplate>,
  ) {}

  async render(
    templateName: string,
    variables: Record<string, string>,
    locale = 'en',
  ): Promise<{ subject: string; body: string; html?: string; markdown?: string }> {
    const template = await this.templateRepo.findOne({
      where: { name: templateName, active: true, locale },
    });

    if (!template) {
      this.logger.warn(`Template ${templateName} not found for locale ${locale}, trying default locale`);
      const fallback = await this.templateRepo.findOne({
        where: { name: templateName, active: true, locale: 'en' },
      });
      if (!fallback) {
        throw new Error(`Template ${templateName} not found`);
      }
      return this.renderTemplate(fallback, variables);
    }

    return this.renderTemplate(template, variables);
  }

  async renderByType(
    type: NotificationType,
    variables: Record<string, string>,
    locale = 'en',
  ): Promise<{ subject: string; body: string; html?: string; markdown?: string }> {
    const template = await this.templateRepo.findOne({
      where: { type, active: true, locale },
    });

    if (!template) {
      const fallback = await this.templateRepo.findOne({
        where: { type, active: true, locale: 'en' },
      });
      if (!fallback) {
        throw new Error(`No active template found for type ${type}`);
      }
      return this.renderTemplate(fallback, variables);
    }

    return this.renderTemplate(template, variables);
  }

  private renderTemplate(
    template: NotificationTemplate,
    variables: Record<string, string>,
  ): { subject: string; body: string; html?: string; markdown?: string } {
    return {
      subject: this.substitute(template.subjectTemplate, variables),
      body: this.substitute(template.bodyTemplate, variables),
      html: template.htmlTemplate ? this.substitute(template.htmlTemplate, variables) : undefined,
      markdown: template.markdownTemplate ? this.substitute(template.markdownTemplate, variables) : undefined,
    };
  }

  private substitute(template: string, variables: Record<string, string>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || `{{${key}}}`);
  }

  async createTemplate(data: Partial<NotificationTemplate>): Promise<NotificationTemplate> {
    return this.templateRepo.save(this.templateRepo.create(data));
  }

  async updateTemplate(id: string, data: Partial<NotificationTemplate>): Promise<NotificationTemplate> {
    await this.templateRepo.update(id, data);
    return this.templateRepo.findOneOrFail({ where: { id } });
  }

  async findAll(): Promise<NotificationTemplate[]> {
    return this.templateRepo.find({ order: { name: 'ASC' } });
  }

  async findOne(id: string): Promise<NotificationTemplate> {
    return this.templateRepo.findOneOrFail({ where: { id } });
  }
}

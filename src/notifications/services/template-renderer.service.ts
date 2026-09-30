import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationTemplate } from '../entities/notification-template.entity';
import { EventType } from '../enums/event-type.enum';
import { DeliveryChannel } from '../interfaces/notification.types';

export interface RenderedNotification {
  title?: string;
  subject?: string;
  body: string;
  html?: string;
  markdown?: string;
  actionUrl?: string;
  channel: DeliveryChannel;
}

/**
 * TemplateRenderer
 * 
 * Renders notification templates with event context.
 * Supports:
 * - Variable substitution ({{variable}} syntax)
 * - Per-event-type templates
 * - Per-channel templates (different for email vs push)
 * - Localization (language variants)
 * - HTML and plaintext rendering
 */
@Injectable()
export class TemplateRenderer {
  private readonly logger = new Logger(TemplateRenderer.name);

  constructor(
    @InjectRepository(NotificationTemplate)
    private templateRepository: Repository<NotificationTemplate>,
  ) {}

  /**
   * Render a notification template for an event
   */
  async render(
    eventType: EventType,
    channel: DeliveryChannel,
    context: Record<string, any>,
    language: string = 'en',
  ): Promise<RenderedNotification> {
    // Load template (try specific language first, fall back to 'en')
    let template = await this.templateRepository.findOne({
      where: {
        type: eventType as any,
        locale: language,
        active: true,
      },
    });

    if (!template && language !== 'en') {
      template = await this.templateRepository.findOne({
        where: {
          type: eventType as any,
          locale: 'en',
          active: true,
        },
      });
    }

    if (!template) {
      // Fall back to generic template if specific not found
      return this.renderGenericNotification(eventType, channel, context);
    }

    // Render templates with context
    const body = this.interpolate(template.bodyTemplate, context);
    const subject = template.subjectTemplate
      ? this.interpolate(template.subjectTemplate, context)
      : this.generateSubject(eventType);
    const html = template.htmlTemplate ? this.interpolate(template.htmlTemplate, context) : null;
    const markdown = template.markdownTemplate
      ? this.interpolate(template.markdownTemplate, context)
      : null;

    return {
      title: subject,
      subject,
      body,
      html: html || this.htmlEscape(body),
      markdown: markdown || body,
      actionUrl: context.actionUrl,
      channel,
    };
  }

  /**
   * Render generic notification when no template exists
   */
  private renderGenericNotification(
    eventType: EventType,
    channel: DeliveryChannel,
    context: Record<string, any>,
  ): RenderedNotification {
    const titles = {
      [EventType.CLAIM_CREATED]: 'New Claim',
      [EventType.VERIFICATION_ASSIGNED]: 'Verification Assigned',
      [EventType.VERIFICATION_COMPLETED]: 'Verification Complete',
      [EventType.DISPUTE_INITIATED]: 'Dispute Initiated',
      [EventType.DISPUTE_RESOLVED]: 'Dispute Resolved',
      [EventType.REWARD_DISTRIBUTED]: 'Rewards Distributed',
      [EventType.REPUTATION_CHANGED]: 'Reputation Update',
      [EventType.GOVERNANCE_PROPOSAL_CREATED]: 'New Governance Proposal',
      [EventType.GOVERNANCE_VOTE_REMINDER]: 'Vote Reminder',
      [EventType.MODERATOR_ACTION]: 'Moderator Action',
      [EventType.SECURITY_INCIDENT]: 'Security Alert',
    };

    const subject = titles[eventType] || eventType;
    const body = this.buildGenericBody(eventType, context);

    return {
      title: subject,
      subject,
      body,
      html: this.htmlEscape(body),
      markdown: body,
      actionUrl: context.actionUrl,
      channel,
    };
  }

  /**
   * Build generic notification body from context
   */
  private buildGenericBody(eventType: EventType, context: Record<string, any>): string {
    const messages: Record<EventType, (ctx: any) => string> = {
      [EventType.CLAIM_CREATED]: (ctx) => `New claim created: "${ctx.title}" for ${ctx.amount} tokens`,
      [EventType.VERIFICATION_ASSIGNED]: (ctx) => `You have been assigned to verify: "${ctx.claimTitle}"`,
      [EventType.VERIFICATION_COMPLETED]: (ctx) => `Verification complete for: "${ctx.claimTitle}"`,
      [EventType.DISPUTE_INITIATED]: (ctx) => `Dispute initiated on claim: "${ctx.claimTitle}"`,
      [EventType.DISPUTE_RESOLVED]: (ctx) => `Dispute resolved on claim: "${ctx.claimTitle}"`,
      [EventType.REWARD_DISTRIBUTED]: (ctx) => `You received ${ctx.amount} reward tokens`,
      [EventType.REPUTATION_CHANGED]: (ctx) => `Your reputation changed by ${ctx.change > 0 ? '+' : ''}${ctx.change}`,
      [EventType.GOVERNANCE_PROPOSAL_CREATED]: (ctx) => `New proposal: "${ctx.proposalTitle}"`,
      [EventType.GOVERNANCE_VOTE_REMINDER]: (ctx) => `Vote ending soon: "${ctx.proposalTitle}"`,
      [EventType.MODERATOR_ACTION]: (ctx) => `Moderation action taken on your account`,
      [EventType.SECURITY_INCIDENT]: (ctx) => `Security alert: ${ctx.message}`,

      // Fill in remaining types with generic messages
      [EventType.CLAIM_UPDATED]: () => 'A claim has been updated',
      [EventType.CLAIM_RESOLVED]: () => 'A claim has been resolved',
      [EventType.CLAIM_ARCHIVED]: () => 'A claim has been archived',
      [EventType.VERIFICATION_CONTESTED]: () => 'A verification has been contested',
      [EventType.DISPUTE_ESCALATED]: () => 'A dispute has been escalated',
      [EventType.GOVERNANCE_VOTE_CAST]: () => 'Your vote has been recorded',
      [EventType.GOVERNANCE_VOTE_CLOSED]: () => 'Voting has closed on a proposal',
      [EventType.GOVERNANCE_PROPOSAL_EXECUTED]: () => 'A governance proposal has been executed',
      [EventType.REWARD_ELIGIBLE]: () => 'You are eligible for rewards',
      [EventType.REWARD_CLAIMED]: () => 'You claimed your rewards',
      [EventType.REPUTATION_WARNING]: () => 'Your reputation is at risk',
      [EventType.REPUTATION_PENALTY]: () => 'Your reputation has been penalized',
      [EventType.STAKE_ADDED]: () => 'Your stake has been added',
      [EventType.STAKE_REMOVED]: () => 'Your stake has been removed',
      [EventType.STAKE_SLASHED]: () => 'Your stake has been slashed',
      [EventType.CONTENT_FLAGGED]: () => 'Your content has been flagged',
      [EventType.USER_RESTRICTED]: () => 'Your account has been restricted',
      [EventType.SYSTEM_ALERT]: () => 'System alert notification',
      [EventType.MAINTENANCE_SCHEDULED]: () => 'Scheduled maintenance announcement',
    };

    const builder = messages[eventType];
    return builder ? builder(context) : `Notification: ${eventType}`;
  }

  /**
   * Interpolate variables in template
   * Supports {{variable}} syntax and nested access via dot notation
   */
  private interpolate(template: string, context: Record<string, any>): string {
    return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, key) => {
      const value = this.getNestedValue(context, key);
      return value !== undefined ? String(value) : match;
    });
  }

  /**
   * Get nested value from object
   * Supports dot notation: {{user.name}}, {{metadata.claim.title}}
   */
  private getNestedValue(obj: Record<string, any>, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  /**
   * Escape HTML in text
   */
  private htmlEscape(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, (char) => map[char]);
  }

  /**
   * Generate subject line from event type
   */
  private generateSubject(eventType: EventType): string {
    const subjectMap: Record<EventType, string> = {
      [EventType.CLAIM_CREATED]: 'New Claim',
      [EventType.VERIFICATION_ASSIGNED]: 'Verification Task',
      [EventType.VERIFICATION_COMPLETED]: 'Verification Complete',
      [EventType.DISPUTE_INITIATED]: 'Dispute Notification',
      [EventType.DISPUTE_RESOLVED]: 'Dispute Resolved',
      [EventType.REWARD_DISTRIBUTED]: 'Rewards Available',
      [EventType.REPUTATION_CHANGED]: 'Reputation Update',
      [EventType.GOVERNANCE_PROPOSAL_CREATED]: 'Vote Now',
      [EventType.GOVERNANCE_VOTE_REMINDER]: 'Voting Ending Soon',
      [EventType.MODERATOR_ACTION]: 'Account Update',
      [EventType.SECURITY_INCIDENT]: 'Security Alert',

      // Defaults for others
      [EventType.CLAIM_UPDATED]: 'Claim Updated',
      [EventType.CLAIM_RESOLVED]: 'Claim Resolved',
      [EventType.CLAIM_ARCHIVED]: 'Claim Archived',
      [EventType.VERIFICATION_CONTESTED]: 'Verification Contested',
      [EventType.DISPUTE_ESCALATED]: 'Dispute Escalated',
      [EventType.GOVERNANCE_VOTE_CAST]: 'Vote Recorded',
      [EventType.GOVERNANCE_VOTE_CLOSED]: 'Voting Closed',
      [EventType.GOVERNANCE_PROPOSAL_EXECUTED]: 'Proposal Executed',
      [EventType.REWARD_ELIGIBLE]: 'Reward Eligible',
      [EventType.REWARD_CLAIMED]: 'Reward Claimed',
      [EventType.REPUTATION_WARNING]: 'Reputation Warning',
      [EventType.REPUTATION_PENALTY]: 'Reputation Penalty',
      [EventType.STAKE_ADDED]: 'Stake Updated',
      [EventType.STAKE_REMOVED]: 'Stake Removed',
      [EventType.STAKE_SLASHED]: 'Stake Slashed',
      [EventType.CONTENT_FLAGGED]: 'Content Flagged',
      [EventType.USER_RESTRICTED]: 'Account Restricted',
      [EventType.SYSTEM_ALERT]: 'System Alert',
      [EventType.MAINTENANCE_SCHEDULED]: 'Maintenance Notice',
    };

    return subjectMap[eventType] || eventType;
  }

  /**
   * Create or update template
   */
  async saveTemplate(
    eventType: EventType,
    language: string,
    subjectTemplate: string,
    bodyTemplate: string,
    options?: {
      htmlTemplate?: string;
      markdownTemplate?: string;
      variables?: string[];
    },
  ): Promise<NotificationTemplate> {
    const name = `${eventType}:${language}`;

    let template = await this.templateRepository.findOne({
      where: { type: eventType as any, locale: language },
    });

    if (!template) {
      template = this.templateRepository.create({
        name,
        type: eventType as any,
        locale: language,
        subjectTemplate,
        bodyTemplate,
        htmlTemplate: options?.htmlTemplate,
        markdownTemplate: options?.markdownTemplate,
        variables: options?.variables || [],
      });
    } else {
      template.subjectTemplate = subjectTemplate;
      template.bodyTemplate = bodyTemplate;
      if (options?.htmlTemplate) template.htmlTemplate = options.htmlTemplate;
      if (options?.markdownTemplate) template.markdownTemplate = options.markdownTemplate;
      if (options?.variables) template.variables = options.variables;
    }

    return this.templateRepository.save(template);
  }

  /**
   * Get all templates for an event type
   */
  async getTemplatesForEvent(eventType: EventType): Promise<NotificationTemplate[]> {
    return this.templateRepository.find({
      where: { type: eventType as any, active: true },
    });
  }
}

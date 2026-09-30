import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationTemplate } from '../entities/notification-template.entity';
import { EventType } from '../enums/event-type.enum';

/**
 * NotificationTemplateService
 * 
 * Manages notification templates and provides template initialization.
 * Handles:
 * - Template CRUD operations
 * - Template versioning
 * - Localization (multi-language support)
 * - Default template initialization
 */
@Injectable()
export class NotificationTemplateService {
  private readonly logger = new Logger(NotificationTemplateService.name);

  constructor(
    @InjectRepository(NotificationTemplate)
    private templateRepository: Repository<NotificationTemplate>,
  ) {}

  /**
   * Create or update a notification template
   */
  async upsertTemplate(
    eventType: EventType,
    locale: string,
    name: string,
    subjectTemplate: string,
    bodyTemplate: string,
    options?: {
      htmlTemplate?: string;
      markdownTemplate?: string;
      variables?: string[];
    },
  ): Promise<NotificationTemplate> {
    let template = await this.templateRepository.findOne({
      where: { type: eventType as any, locale },
    });

    if (!template) {
      template = this.templateRepository.create({
        name,
        type: eventType as any,
        locale,
        subjectTemplate,
        bodyTemplate,
        htmlTemplate: options?.htmlTemplate,
        markdownTemplate: options?.markdownTemplate,
        variables: options?.variables || this.extractVariables(bodyTemplate),
        version: 1,
        active: true,
      });
    } else {
      template.name = name;
      template.subjectTemplate = subjectTemplate;
      template.bodyTemplate = bodyTemplate;
      if (options?.htmlTemplate) template.htmlTemplate = options.htmlTemplate;
      if (options?.markdownTemplate) template.markdownTemplate = options.markdownTemplate;
      if (options?.variables) template.variables = options.variables;
      template.version = (template.version || 1) + 1;
    }

    return this.templateRepository.save(template);
  }

  /**
   * Get template for event type and locale
   */
  async getTemplate(eventType: EventType, locale: string = 'en'): Promise<NotificationTemplate | null> {
    return this.templateRepository.findOne({
      where: { type: eventType as any, locale, active: true },
    });
  }

  /**
   * Get all templates for an event type
   */
  async getTemplatesByEventType(eventType: EventType): Promise<NotificationTemplate[]> {
    return this.templateRepository.find({
      where: { type: eventType as any, active: true },
      order: { locale: 'ASC' },
    });
  }

  /**
   * Deactivate a template
   */
  async deactivateTemplate(templateId: string): Promise<void> {
    await this.templateRepository.update({ id: templateId }, { active: false });
  }

  /**
   * Initialize default templates
   * Called on application startup
   */
  async initializeDefaultTemplates(): Promise<number> {
    let count = 0;

    for (const [eventType, templates] of Object.entries(this.DEFAULT_TEMPLATES)) {
      for (const [locale, template] of Object.entries(templates)) {
        try {
          await this.upsertTemplate(
            eventType as EventType,
            locale,
            `${eventType}:${locale}`,
            template.subject,
            template.body,
            {
              htmlTemplate: template.html,
              variables: template.variables,
            },
          );
          count++;
        } catch (error) {
          this.logger.warn(
            `Failed to initialize template for ${eventType}:${locale}: ${error.message}`,
          );
        }
      }
    }

    this.logger.log(`Initialized ${count} default notification templates`);
    return count;
  }

  /**
   * Extract variable names from template string
   * Matches {{variable}} pattern
   */
  private extractVariables(template: string): string[] {
    const regex = /\{\{(\w+(?:\.\w+)*)\}\}/g;
    const variables = new Set<string>();
    let match;

    while ((match = regex.exec(template)) !== null) {
      variables.add(match[1].split('.')[0]); // Get root variable name
    }

    return Array.from(variables);
  }

  /**
   * Default templates for all event types
   */
  private readonly DEFAULT_TEMPLATES: Record<string, Record<string, any>> = {
    [EventType.CLAIM_CREATED]: {
      en: {
        subject: 'New Claim: {{title}}',
        body: '{{senderName}} created a new claim: "{{title}}" for {{amount}} tokens.\n\nView the claim: {{claimUrl}}',
        html: '<p><strong>{{senderName}}</strong> created a new claim: <strong>"{{title}}"</strong> for <strong>{{amount}} tokens</strong>.</p><p><a href="{{claimUrl}}">View Claim</a></p>',
        variables: ['senderName', 'title', 'amount', 'claimUrl'],
      },
    },

    [EventType.VERIFICATION_ASSIGNED]: {
      en: {
        subject: 'Verification Task: {{claimTitle}}',
        body: 'You have been assigned to verify the claim: "{{claimTitle}}"\n\nVerify: {{verificationUrl}}',
        html: '<p>You have been assigned to verify: <strong>"{{claimTitle}}"</strong></p><p><a href="{{verificationUrl}}">Start Verification</a></p>',
        variables: ['claimTitle', 'verificationUrl'],
      },
    },

    [EventType.VERIFICATION_COMPLETED]: {
      en: {
        subject: 'Verification Complete: {{claimTitle}}',
        body: 'Verification has been completed for: "{{claimTitle}}"\n\nVerifier: {{verifierName}}\nVerdict: {{verdict}}\n\nView details: {{claimUrl}}',
        html: '<p>Verification completed for: <strong>"{{claimTitle}}"</strong></p><p>Verdict: <strong>{{verdict}}</strong></p><p><a href="{{claimUrl}}">View Claim</a></p>',
        variables: ['claimTitle', 'verifierName', 'verdict', 'claimUrl'],
      },
    },

    [EventType.DISPUTE_INITIATED]: {
      en: {
        subject: 'Dispute Initiated: {{claimTitle}}',
        body: 'A dispute has been initiated on: "{{claimTitle}}"\n\nDispute reason: {{reason}}\n\nView: {{disputeUrl}}',
        html: '<p>A dispute has been initiated on: <strong>"{{claimTitle}}"</strong></p><p>Reason: {{reason}}</p><p><a href="{{disputeUrl}}">View Dispute</a></p>',
        variables: ['claimTitle', 'reason', 'disputeUrl'],
      },
    },

    [EventType.DISPUTE_RESOLVED]: {
      en: {
        subject: 'Dispute Resolved: {{claimTitle}}',
        body: 'The dispute on "{{claimTitle}}" has been resolved.\n\nOutcome: {{outcome}}\n\nDetails: {{disputeUrl}}',
        html: '<p>Dispute resolved for: <strong>"{{claimTitle}}"</strong></p><p>Outcome: {{outcome}}</p><p><a href="{{disputeUrl}}">View Resolution</a></p>',
        variables: ['claimTitle', 'outcome', 'disputeUrl'],
      },
    },

    [EventType.REWARD_DISTRIBUTED]: {
      en: {
        subject: 'You Earned {{amount}} Reward Tokens',
        body: 'Congratulations! You earned {{amount}} reward tokens for {{reason}}.\n\nClaim your rewards: {{claimUrl}}',
        html: '<p>🎉 Congratulations! You earned <strong>{{amount}} reward tokens</strong></p><p>Reason: {{reason}}</p><p><a href="{{claimUrl}}">Claim Rewards</a></p>',
        variables: ['amount', 'reason', 'claimUrl'],
      },
    },

    [EventType.REPUTATION_CHANGED]: {
      en: {
        subject: 'Your Reputation Has Changed',
        body: 'Your reputation score changed by {{change}} ({{changeType}}).\n\nCurrent score: {{currentScore}}\n\nDetails: {{profileUrl}}',
        html: '<p>Your reputation changed: <strong>{{change}}</strong></p><p>Type: {{changeType}}</p><p>Current: {{currentScore}}</p><p><a href="{{profileUrl}}">View Profile</a></p>',
        variables: ['change', 'changeType', 'currentScore', 'profileUrl'],
      },
    },

    [EventType.REPUTATION_PENALTY]: {
      en: {
        subject: '⚠️ Reputation Penalty Applied',
        body: 'A reputation penalty has been applied to your account.\n\nPenalty: {{penaltyAmount}}\nReason: {{reason}}\n\nCurrent score: {{currentScore}}',
        html: '<p>⚠️ <strong>Reputation Penalty Applied</strong></p><p>Amount: {{penaltyAmount}}</p><p>Reason: {{reason}}</p><p>Current Score: {{currentScore}}</p>',
        variables: ['penaltyAmount', 'reason', 'currentScore'],
      },
    },

    [EventType.GOVERNANCE_PROPOSAL_CREATED]: {
      en: {
        subject: 'New Governance Proposal: {{proposalTitle}}',
        body: 'A new governance proposal has been created: "{{proposalTitle}}"\n\nDescription: {{description}}\n\nVote: {{proposalUrl}}',
        html: '<p>New governance proposal: <strong>"{{proposalTitle}}"</strong></p><p>{{description}}</p><p><a href="{{proposalUrl}}">Vote Now</a></p>',
        variables: ['proposalTitle', 'description', 'proposalUrl'],
      },
    },

    [EventType.GOVERNANCE_VOTE_REMINDER]: {
      en: {
        subject: '📋 Voting Ending Soon: {{proposalTitle}}',
        body: 'Voting is ending soon for: "{{proposalTitle}}"\n\nEnds in: {{timeRemaining}}\n\nCast your vote: {{proposalUrl}}',
        html: '<p>📋 <strong>Voting ending soon for "{{proposalTitle}}"</strong></p><p>Time remaining: {{timeRemaining}}</p><p><a href="{{proposalUrl}}">Vote Now</a></p>',
        variables: ['proposalTitle', 'timeRemaining', 'proposalUrl'],
      },
    },

    [EventType.MODERATOR_ACTION]: {
      en: {
        subject: 'Moderator Action on Your Account',
        body: 'A moderator action has been taken on your account.\n\nAction: {{actionType}}\nReason: {{reason}}\n\nAppeal: {{appealUrl}}',
        html: '<p>Moderator Action: <strong>{{actionType}}</strong></p><p>Reason: {{reason}}</p><p><a href="{{appealUrl}}">View/Appeal</a></p>',
        variables: ['actionType', 'reason', 'appealUrl'],
      },
    },

    [EventType.SECURITY_INCIDENT]: {
      en: {
        subject: '🔒 Security Alert',
        body: 'A security alert has been detected.\n\nAlert: {{alertType}}\n\nAction: {{action}}\n\nMore info: {{infoUrl}}',
        html: '<p>🔒 <strong>Security Alert</strong></p><p>Type: {{alertType}}</p><p>Recommended action: {{action}}</p><p><a href="{{infoUrl}}">Learn More</a></p>',
        variables: ['alertType', 'action', 'infoUrl'],
      },
    },

    [EventType.SYSTEM_ALERT]: {
      en: {
        subject: 'System Alert: {{alertTitle}}',
        body: '{{alertMessage}}\n\nMore info: {{infoUrl}}',
        html: '<p><strong>{{alertTitle}}</strong></p><p>{{alertMessage}}</p><p><a href="{{infoUrl}}">Learn More</a></p>',
        variables: ['alertTitle', 'alertMessage', 'infoUrl'],
      },
    },

    [EventType.MAINTENANCE_SCHEDULED]: {
      en: {
        subject: 'Scheduled Maintenance Announced',
        body: 'Scheduled maintenance has been announced.\n\nStart: {{startTime}}\nDuration: {{duration}}\n\nDetails: {{infoUrl}}',
        html: '<p>⏰ <strong>Scheduled Maintenance</strong></p><p>Start: {{startTime}}</p><p>Duration: {{duration}} minutes</p><p><a href="{{infoUrl}}">More Info</a></p>',
        variables: ['startTime', 'duration', 'infoUrl'],
      },
    },

    [EventType.STAKE_SLASHED]: {
      en: {
        subject: '⚠️ Stake Slashed: {{amount}} tokens',
        body: 'Your stake has been slashed.\n\nAmount: {{amount}}\nReason: {{reason}}\n\nDetails: {{accountUrl}}',
        html: '<p>⚠️ <strong>Stake Slashed</strong></p><p>Amount: {{amount}} tokens</p><p>Reason: {{reason}}</p><p><a href="{{accountUrl}}">View Account</a></p>',
        variables: ['amount', 'reason', 'accountUrl'],
      },
    },

    [EventType.USER_RESTRICTED]: {
      en: {
        subject: '🚫 Account Restricted',
        body: 'Your account has been restricted.\n\nRestriction: {{restrictionType}}\nReason: {{reason}}\n\nAppeal: {{appealUrl}}',
        html: '<p>🚫 <strong>Account Restricted</strong></p><p>Type: {{restrictionType}}</p><p>Reason: {{reason}}</p><p><a href="{{appealUrl}}">Appeal Restriction</a></p>',
        variables: ['restrictionType', 'reason', 'appealUrl'],
      },
    },
  };
}

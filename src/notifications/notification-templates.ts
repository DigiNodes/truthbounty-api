import { EventType } from './notification-events';
import { DeliveryChannel } from './interfaces/notification.types';
import { parseDeliveryChannel } from './delivery/delivery-channel';

export { DeliveryChannel as NotificationChannel };

export interface NotificationTemplate {
  readonly subject: string;
  readonly body: string;
}

export type TemplateVariables = Record<string, string | number | boolean | null | undefined>;

export type EventTemplateMap = Record<EventType, NotificationTemplate>;

const ESCAPE_HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).replace(/[&<>"']/g, (char) => ESCAPE_HTML_ENTITIES[char] ?? char);
}

export function escapeMarkdown(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).replace(/[\\\\`$_*\[\]\(\)<>#!+-.|^${}|~]/g, (char) => `\\${char}`);
}

export function renderTemplate(
  template: string,
  variables: TemplateVariables,
  channel: DeliveryChannel | NotificationChannel | string,
  escaper: (value: unknown) => string = parseDeliveryChannel(channel) === DeliveryChannel.EMAIL ? escapeHtml : escapeMarkdown,
): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) {
      throw new Error(`Missing template variable: ${key}`);
    }
    return escaper(variables[key]);
  });
}

export const EVENT_TEMPLATES: EventTemplateMap = {
  [EventType.CLAIM_CREATED]: {
    subject: 'Claim created: {{claimTitle}}',
    body: 'Your claim "{{claimTitle}}" has been created.',
  },
  [EventType.CLAIM_UPDATED]: {
    subject: 'Claim updated: {{claimTitle}}',
    body: 'Claim "{{claimTitle}}" was updated to status "{{status}}".',
  },
  [EventType.CLAIM_RESOLVED]: {
    subject: 'Claim resolved: {{claimTitle}}',
    body: 'Claim "{{claimTitle}}" was resolved with outcome "{{outcome}}".',
  },
  [EventType.VERIFICATION_REQUESTED]: {
    subject: 'Verification requested',
    body: 'A verification request was submitted for "{{subjectName}}".',
  },
  [EventType.VERIFICATION_COMPLETED]: {
    subject: 'Verification completed',
    body: 'Verification for "{{subjectName}}" completed with result "{{result}}".',
  },
  [EventType.VERIFICATION_FAILED]: {
    subject: 'Verification failed',
    body: 'Verification for "{{subjectName}}" failed: {{reason}}.',
  },
  [EventType.DISPUTE_OPENED]: {
    subject: 'Dispute opened: {{disputeTitle}}',
    body: 'Dispute "{{disputeTitle}}" has been opened by:"{{openerName}}".',
  },
  [EventType.DISPUTE_RESOLVED]: {
    subject: 'Dispute resolved: {{disputeTitle}}',
    body: 'Dispute "{{disputeTitle}}" was resolved with outcome "{{outcome}}".',
  },
  [EventType.GOVERNANCE_PROPOSAL_CREATED]: {
    subject: 'Governance proposal created: {{proposalTitle}}',
    body: 'Proposal "{{proposalTitle}}" was created by "{{proposerName}}".',
  },
  [EventType.GOVERNANCE_VOTE_CAST]: {
    subject: 'Vote cast on {{proposalTitle}}',
    body: 'A vote of "{{vote}}" was cast on "{{proposalTitle}}".',
  },
  [EventType.GOVERNANCE_PROPOSAL_RESOLVED]: {
    subject: 'Governance proposal resolved: {{proposalTitle}}',
    body: 'Proposal "{{proposalTitle}}" resolved with outcome "{{outcome}}".',
  },
  [EventType.REWARD_ISSUED]: {
    subject: 'Reward issued: {{amount}}',
    body: 'A reward of "{{amount}}" was issued for "{{reason}}".',
  },
  [EventType.REWARD_CLAIMED]: {
    subject: 'Reward claimed: {{amount}}',
    body: 'You claimed a reward of "{{amount}}".',
  },
  [EventType.MODERATION_ACTION]: {
    subject: 'Moderation action on {{contentTitle}}',
    body: 'A moderation action "{{action}}" was taken on {{contentTitle}} by {{moderatorName}}.',
  },
  [EventType.SUPPORT_TICKET_CREATED]: {
    subject: 'Support ticket created: {{ticketSubject}}',
    body: 'Support ticket "{{ticketSubject}}" was created.',
  },
  [EventType.SUPPORT_TICKET_REPLIED]: {
    subject: 'Support ticket replied: {{ticketSubject}}',
    body: 'A reply was added to support ticket "{{ticketSubject}}".',
  },
};

export function getTemplate(eventType: EventType): NotificationTemplate {
  const template = EVENT_TEMPLATES[eventType];
  if (!template) {
    throw new Error(`No notification template registered for event type: ${eventType}`);
  }
  return template;
}

import { IsEnum, IsString, IsArray, IsObject, IsOptional } from 'class-validator';
import { EventType } from '../enums/event-type.enum';

/**
 * DTO for publishing protocol events to the notification system
 * Events are routed to one or more recipients who will receive notifications
 * based on their preferences
 */
export class PublishEventDto {
  /**
   * Type of protocol event (e.g., CLAIM_CREATED, VERIFICATION_COMPLETED)
   */
  @IsEnum(EventType)
  eventType: EventType;

  /**
   * Aggregate ID of the entity that triggered the event
   * Used for idempotency and tracing
   */
  @IsString()
  aggregateId: string;

  /**
   * User IDs who should receive notifications for this event
   * Can be empty for broadcast events
   */
  @IsArray()
  @IsString({ each: true })
  recipientIds: string[];

  /**
   * Event-specific metadata
   * Should NOT contain PII or settlement data (only used for notification routing)
   * Examples: { claimId, amount, title, stakeholders, actionUrl }
   */
  @IsObject()
  metadata: Record<string, any>;

  /**
   * Optional tags for filtering/categorization
   */
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  /**
   * User ID of the entity that triggered the event (optional)
   * Used for context/audit trails
   */
  @IsString()
  @IsOptional()
  sourceUserId?: string;
}

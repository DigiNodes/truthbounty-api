import {
  IsEnum,
  IsString,
  IsNotEmpty,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  IsObject,
  IsOptional,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EventType } from '../enums/event-type.enum';

/** Maximum number of recipients allowed per single notification event. */
export const MAX_RECIPIENTS_PER_EVENT = 1000;

/** Maximum number of events allowed in a single batch publish request. */
export const MAX_BATCH_EVENTS = 100;

/** Maximum total recipients across all events in a single batch publish request. */
export const MAX_BATCH_TOTAL_RECIPIENTS = 5000;

/**
 * DTO for publishing protocol events to the notification system.
 * Events are routed to one or more recipients who will receive notifications
 * based on their preferences.
 */
export class PublishEventDto {
  /**
   * Type of protocol event (e.g., CLAIM_CREATED, VERIFICATION_COMPLETED)
   */
  @ApiProperty({ enum: EventType, description: 'Protocol event type' })
  @IsEnum(EventType)
  eventType: EventType;

  /**
   * Aggregate ID of the entity that triggered the event
   * Used for idempotency and tracing
   */
  @ApiProperty({ description: 'Aggregate ID of the triggering entity' })
  @IsString()
  @IsNotEmpty()
  aggregateId: string;

  /**
   * User IDs who should receive notifications for this event.
   * Must contain between 1 and MAX_RECIPIENTS_PER_EVENT non-empty IDs.
   */
  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: MAX_RECIPIENTS_PER_EVENT,
    description: 'Eligible recipient user IDs',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_RECIPIENTS_PER_EVENT)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  recipientIds: string[];

  /**
   * Event-specific metadata
   * Should NOT contain PII or settlement data (only used for notification routing)
   * Examples: { claimId, amount, title, stakeholders, actionUrl }
   */
  @ApiProperty({ type: Object, description: 'Event routing metadata' })
  @IsObject()
  metadata: Record<string, any>;

  /**
   * Optional tags for filtering/categorization
   */
  @ApiPropertyOptional({ type: [String], description: 'Optional event tags' })
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @IsOptional()
  tags?: string[];

  /**
   * User ID of the entity that triggered the event (optional)
   * Used for context/audit trails and event-status ownership checks
   */
  @ApiPropertyOptional({ description: 'Triggering user ID for audit/ownership' })
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  sourceUserId?: string;
}

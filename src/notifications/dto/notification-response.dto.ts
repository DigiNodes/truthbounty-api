import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  NotificationType,
  NotificationPriority,
  DeliveryChannel,
  DeliveryStatus,
} from '../enums/notification-type.enum';

export class DeliveryResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: DeliveryChannel })
  channel: DeliveryChannel;

  @ApiProperty({ enum: DeliveryStatus })
  status: DeliveryStatus;

  @ApiPropertyOptional()
  destination?: string;

  @ApiProperty()
  retryCount: number;

  @ApiPropertyOptional()
  failureReason?: string;

  @ApiPropertyOptional()
  sentAt?: Date;

  @ApiPropertyOptional()
  deliveredAt?: Date;

  @ApiProperty()
  createdAt: Date;
}

export class NotificationResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  userId: string;

  @ApiPropertyOptional()
  walletAddress?: string;

  @ApiProperty({ enum: NotificationType })
  type: NotificationType;

  @ApiProperty()
  title: string;

  @ApiProperty()
  body: string;

  @ApiPropertyOptional()
  data?: Record<string, any>;

  @ApiProperty({ enum: NotificationPriority })
  priority: NotificationPriority;

  @ApiProperty()
  read: boolean;

  @ApiPropertyOptional()
  readAt?: Date;

  @ApiProperty()
  status: string;

  @ApiPropertyOptional()
  scheduledAt?: Date;

  @ApiPropertyOptional()
  sentAt?: Date;

  @ApiProperty()
  createdAt: Date;

  @ApiPropertyOptional({ type: [DeliveryResponseDto] })
  deliveries?: DeliveryResponseDto[];
}

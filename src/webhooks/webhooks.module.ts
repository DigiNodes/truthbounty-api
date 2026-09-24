import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { Webhook } from './entities/webhook.entity';
import { WebhookSubscription } from './entities/webhook-subscription.entity';
import { WebhookDelivery } from './entities/webhook-delivery.entity';
import { WebhooksService } from './webhooks.service';
import { WebhooksController } from './webhooks.controller';
import { WebhookProcessor } from './webhooks.processor';

@Module({
  imports: [
    TypeOrmModule.forFeature([Webhook, WebhookSubscription, WebhookDelivery]),
    BullModule.registerQueue({
      name: 'webhook-delivery',
      defaultJobOptions: {
        attempts: 4,
        backoff: {
          type: 'exponential',
          delay: 30000,
        },
        removeOnComplete: false,
        removeOnFail: false,
      },
    }),
    BullBoardModule.forFeature({
      name: 'webhook-delivery',
      adapter: BullMQAdapter,
    }),
  ],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookProcessor],
  exports: [WebhooksService],
})
export class WebhooksModule {}

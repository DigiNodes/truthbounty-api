import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboundWebhookService } from './outbound-webhook.service';
import { WebhookEndpointEntity } from './entities/webhook-endpoint.entity';
import { WebhookDeliveryEntity } from './entities/webhook-delivery.entity';

@Module({
  imports: [TypeOrmModule.forFeature([WebhookEndpointEntity, WebhookDeliveryEntity])],
  providers: [OutboundWebhookService],
  exports: [OutboundWebhookService],
})
export class OutboundWebhookModule {}

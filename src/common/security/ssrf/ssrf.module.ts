import { Module } from '@nestjs/common';
import { SafeHttpClientService } from './safe-http-client.service';

@Module({
  providers: [SafeHttpClientService],
  exports: [SafeHttpClientService],
})
export class SsrfModule {}

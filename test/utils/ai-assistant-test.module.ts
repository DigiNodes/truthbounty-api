import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import throttlerConfig from '../../src/config/throttler.config';
import { WalletThrottlerGuard } from '../../src/common/guards/wallet-throttler.guard';
import { RedisModule } from '../../src/redis/redis.module';
import { AuthModule } from '../../src/auth/auth.module';
import { GlobalAuthGuard } from '../../src/auth/global-auth.guard';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { MetricsModule } from '../../src/metrics/metrics.module';
import { AiAssistantModule } from '../../src/ai-assistant/ai-assistant.module';

/**
 * Trimmed-down stand-in for AppModule, used only by AI-assistant e2e specs.
 *
 * AppModule cannot currently be compiled by ts-jest for e2e runs: DisputeModule
 * (DisputeController calling DisputeService with a stale, pre-refactor
 * positional-args signature) and several other modules (ClaimsModule via a
 * corrupted evidence.service.ts, IdentityModule, JobsModule) fail to type-check.
 * These are pre-existing defects on `main`, unrelated to the AI assistant
 * feature and outside this ticket's scope — confirmed by running the
 * repo's own pre-existing test/auth.e2e-spec.ts through the same jest-e2e
 * config, which fails identically.
 *
 * This module reproduces only the slice of app.module.ts's wiring the AI
 * assistant module actually depends on (config, sqlite TypeORM, throttler,
 * Redis, auth, Prisma, metrics) so its own e2e tests can run against real
 * HTTP + real auth + a real (temporary) database, without pulling in the
 * broken modules.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [throttlerConfig],
      envFilePath: ['.env.local', '.env'],
    }),
    TypeOrmModule.forRoot({
      type: 'sqlite',
      database: process.env.AI_E2E_DATABASE || ':memory:',
      entities: [__dirname + '/../../src/ai-assistant/entities/*.entity{.ts,.js}'],
      synchronize: true,
      logging: false,
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        throttlers: [
          {
            ttl: configService.get<number>('throttler.default.ttl', 60000),
            limit: configService.get<number>('throttler.default.limit', 10),
          },
        ],
      }),
    }),
    RedisModule,
    AuthModule,
    PrismaModule,
    MetricsModule,
    AiAssistantModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: GlobalAuthGuard },
    { provide: APP_GUARD, useClass: WalletThrottlerGuard },
  ],
})
export class AiAssistantTestModule {}

import { Module, Global, Logger, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AuditStreamRecordEntity } from './entities/audit-stream-record.entity';
import { AuditStreamCheckpointEntity } from './entities/audit-stream-checkpoint.entity';
import { AuditKeyMetadataEntity } from './entities/audit-key-metadata.entity';
import { DurableAuditStreamStore } from './stores/durable-audit-stream.store';
import { InMemoryAuditStreamStore } from './stores/in-memory-audit-stream.store';
import { AuditStreamStore } from './stores/audit-stream.store';
import { SecretAuditKeyRegistry } from './key-registry/secret-audit-key-registry';
import { AuditStreamService } from './services/audit-stream.service';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AuditStreamRecordEntity,
      AuditStreamCheckpointEntity,
      AuditKeyMetadataEntity,
    ]),
  ],
  providers: [
    {
      provide: AuditStreamStore,
      useFactory: (
        configService: ConfigService,
        dataSource: DataSource,
      ): AuditStreamStore => {
        const isProduction = configService.get('NODE_ENV') === 'production';
        const logger = new Logger('AuditStreamModule');

        if (isProduction) {
          logger.log('Production mode: initializing DurableAuditStreamStore');
          // Repositories will be injected by NestJS after DataSource is ready
          return new DurableAuditStreamStore(
            dataSource.getRepository(AuditStreamRecordEntity),
            dataSource.getRepository(AuditStreamCheckpointEntity),
            dataSource,
          );
        }

        logger.warn('Development mode: using InMemoryAuditStreamStore');
        return new InMemoryAuditStreamStore();
      },
      inject: [ConfigService, DataSource],
    },
    SecretAuditKeyRegistry,
    AuditStreamService,
  ],
  exports: [AuditStreamService, AuditStreamStore, SecretAuditKeyRegistry],
})
export class AuditStreamModule implements OnModuleInit {
  private readonly logger = new Logger(AuditStreamModule.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly store: AuditStreamStore,
    private readonly keyRegistry: SecretAuditKeyRegistry,
  ) {}

  onModuleInit() {
    const isProduction = this.configService.get('NODE_ENV') === 'production';

    if (isProduction && this.store instanceof InMemoryAuditStreamStore) {
      const error =
        'CRITICAL: Production audit configured with InMemoryAuditStreamStore. ' +
        'Set NODE_ENV=production and ensure database is configured.';
      this.logger.error(error);
      throw new Error(error);
    }

    // Check production key requirements
    if (isProduction) {
      const activeKeyId = this.configService.get('AUDIT_ACTIVE_KEY_ID');
      if (!activeKeyId) {
        const error = 'CRITICAL: Production audit requires AUDIT_ACTIVE_KEY_ID environment variable.';
        this.logger.error(error);
        throw new Error(error);
      }

      const keyMaterial = this.configService.get(
        `AUDIT_HMAC_KEY_${activeKeyId}`,
      );
      if (!keyMaterial) {
        const error = `CRITICAL: Production audit requires AUDIT_HMAC_KEY_${activeKeyId} in secrets.`;
        this.logger.error(error);
        throw new Error(error);
      }
    }

    this.logger.log(
      `AuditStreamModule initialized with ${this.store.constructor.name}`,
    );
  }
}

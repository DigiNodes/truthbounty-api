// src/database/migration-validator.service.ts
import { Injectable, OnModuleInit, Logger, InternalServerErrorException } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class MigrationValidatorService implements OnModuleInit {
    private readonly logger = new Logger(MigrationValidatorService.name);
    private readonly REQUIRED_SCHEMA_VERSION = 2;

    constructor(private readonly dataSource: DataSource) {}

    async onModuleInit(): Promise<void> {
        await this.verifySchemaVersion();
    }

    private async verifySchemaVersion(): Promise<void> {
        this.logger.log('Verifying V2 database migration baseline and schema compatibility...');
        
        try {
            const hasTable = await this.dataSource.query(
                `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'v2_schema_versions');`
            );

            if (!hasTable[0]?.exists) {
                throw new InternalServerErrorException(
                    'Critical: v2_schema_versions table is missing. Database is not at V2 baseline.'
                );
            }

            const result = await this.dataSource.query(
                `SELECT MAX(version) as current_version FROM "v2_schema_versions";`
            );

            const currentVersion = parseInt(result[0]?.current_version, 10);

            if (currentVersion !== this.REQUIRED_SCHEMA_VERSION) {
                throw new InternalServerErrorException(
                    `Incompatible schema version detected: expected v${this.REQUIRED_SCHEMA_VERSION}, found v${currentVersion}. Application startup aborted.`
                );
            }

            this.logger.log(`Schema version v${currentVersion} verified successfully. Application startup proceeding.`);
        } catch (error) {
            this.logger.error(`Migration validation failed: ${error.message}`);
            // Fail closed on incompatible or missing schema version
            process.exit(1);
        }
    }
}
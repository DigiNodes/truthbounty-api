import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

/**
 * SeedService executes database seeding for development, testing,
 * and demo environments only. Seed data is NEVER executed in production.
 */
@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const nodeEnv = this.configService.get<string>('NODE_ENV', 'development');
    const seedEnabled = this.configService.get<string>('DATABASE_SEED') === 'true';

    // Never seed in production
    if (nodeEnv === 'production') {
      this.logger.log('Seeding skipped: production environment');
      return;
    }

    // Only seed if explicitly enabled or in development
    if (!seedEnabled && nodeEnv !== 'development') {
      this.logger.log('Seeding skipped: not enabled for this environment');
      return;
    }

    await this.seed();
  }

  private async seed(): Promise<void> {
    this.logger.log('Starting database seeding...');
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Seed data is added here as the application evolves.
      // Each seed function should be idempotent.
      await this.seedUsers(queryRunner.manager);
      await queryRunner.commitTransaction();
      this.logger.log('Database seeding completed successfully');
    } catch (err) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Database seeding failed: ${err.message}`);
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  private async seedUsers(manager: any): Promise<void> {
    // Idempotent user seeding for development/demo environments
    const count = await manager.count('users');
    if (count > 0) {
      this.logger.log('Users already seeded, skipping');
      return;
    }

    // Add development seed users here as needed
    this.logger.log('No seed users defined yet');
  }
}

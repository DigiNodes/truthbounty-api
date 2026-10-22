import { getRuntimeEnvironment } from '../config/runtime-config';
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '../generated/client/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * STAB-BE-006: Prisma/PostgreSQL is the single persistence authority.
 *
 * The client is wired through `@prisma/adapter-pg` with the one canonical
 * `DATABASE_URL`. There is deliberately no SQLite/libsql fallback: a missing
 * or non-postgreSQL URL fails closed at construction instead of silently
 * opening a second, divergent persistence path.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const connectionString = getRuntimeEnvironment().DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL: required explicitly (Prisma/PostgreSQL is the canonical persistence authority; no SQLite/libsql fallback)',
      );
    }

    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

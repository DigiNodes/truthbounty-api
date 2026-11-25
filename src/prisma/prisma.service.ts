import { getRuntimeEnvironment } from '../config/runtime-config';
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '../generated/client/client';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const connectionString = getRuntimeEnvironment().DATABASE_URL;
    if (!connectionString || !/^postgres(?:ql)?:\/\//i.test(connectionString)) {
      throw new Error('DATABASE_URL must be a PostgreSQL connection string');
    }
    const adapter = new PrismaPg({ connectionString });

    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

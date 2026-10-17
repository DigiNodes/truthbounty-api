import { getRuntimeEnvironment } from '../config/runtime-config';
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '../generated/client/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';


@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const connectionString = getRuntimeEnvironment().DATABASE_URL || 'file:./dev.db';
    const adapter = new PrismaLibSql({ url: connectionString });

    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

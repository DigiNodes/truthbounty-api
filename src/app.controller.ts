import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AppService } from './app.service';
import { RedisService } from './redis/redis.service';
import { PrismaService } from './prisma/prisma.service';
import { DataSource } from 'typeorm';
import { Public } from './decorators/public.decorator';

@ApiTags('health')
@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly redisService: RedisService,
    private readonly prismaService: PrismaService,
    private readonly dataSource: DataSource,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Get application health status' })
  async getHealth() {
    let dbStatus = 'healthy';
    let prismaStatus = 'healthy';
    let redisStatus = 'healthy';
    let isHealthy = true;

    // Check TypeORM DB
    try {
      const result = await this.dataSource.query('SELECT 1');
      if (!result || result.length === 0) {
        dbStatus = 'unhealthy';
        isHealthy = false;
      }
    } catch (err) {
      dbStatus = `unhealthy: ${err.message}`;
      isHealthy = false;
    }

    // Check Prisma DB
    try {
      const result = await this.prismaService.$queryRaw`SELECT 1`;
      if (!result) {
        prismaStatus = 'unhealthy';
        isHealthy = false;
      }
    } catch (err) {
      prismaStatus = `unhealthy: ${err.message}`;
      isHealthy = false;
    }

    // Check Redis
    try {
      const redisHealthy = await this.redisService.isHealthy();
      if (!redisHealthy) {
        redisStatus = 'unhealthy';
        isHealthy = false;
      }
    } catch (err) {
      redisStatus = `unhealthy: ${err.message}`;
      isHealthy = false;
    }

    return {
      status: isHealthy ? 'OK' : 'Error',
      timestamp: new Date().toISOString(),
      services: {
        database: dbStatus,
        prisma: prismaStatus,
        redis: redisStatus,
      },
    };
  }
}

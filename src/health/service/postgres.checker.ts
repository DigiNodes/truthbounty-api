import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class PostgresChecker {
  constructor(
    private readonly dataSource: DataSource,
  ) {}

  async check() {
    const start = Date.now();

    try {
      await this.dataSource.query('SELECT 1');

      return {
        name: 'PostgreSQL',
        status: 'Healthy',
        latency: Date.now() - start,
      };
    } catch (err) {
      return {
        name: 'PostgreSQL',
        status: 'Unhealthy',
        latency: Date.now() - start,
        reason: err.message,
      };
    }
  }
}
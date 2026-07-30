import { Injectable } from '@nestjs/common';

@Injectable()
export class MonitoringService {
  getStats() {
    return {
      activeWorkers: 3,

      queuedJobs: 18,

      completedJobs: 2140,

      failedJobs: 12,

      retries: 9,
    };
  }
}
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { JobsService } from './jobs.service';

@Processor('jobs-queue')
@Injectable()
export class JobsProcessor extends WorkerHost {
  private readonly logger = new Logger(JobsProcessor.name);

  constructor(private readonly jobsService: JobsService) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.log(`Processing job ${job.id} of name ${job.name}`);
    switch (job.name) {
      case 'compute-scores':
        await this.jobsService.computeScores();
        return { success: true };
      case 'compute-reputation':
        await this.jobsService.computeReputation();
        return { success: true };
      case 'cleanup-sybil-history':
        const deletedCount = await this.jobsService.cleanupSybilHistory();
        return { success: true, deletedCount };
      default:
        throw new Error(`Unknown job name: ${job.name}`);
    }
  }
}

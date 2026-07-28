import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { JobName, QueueName } from './jobs.types';

@Processor(QueueName.DEFAULT)
@Injectable()
export class JobsProcessor extends WorkerHost {
  private readonly logger = new Logger(JobsProcessor.name);

  constructor(private readonly jobsService: JobsService) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.log(`Processing job ${job.id} of name ${job.name}`);
    switch (job.name) {
      case JobName.COMPUTE_SCORES:
        return this.jobsService.runComputeScores();
      case JobName.COMPUTE_REPUTATION:
        return this.jobsService.runComputeReputation();
      case JobName.CLEANUP_SYBIL_HISTORY: {
        const deletedCount = await this.jobsService.cleanupSybilHistory();
        return { deletedCount };
      }
      default:
        throw new Error(`Unknown job name: ${job.name}`);
    }
  }
}

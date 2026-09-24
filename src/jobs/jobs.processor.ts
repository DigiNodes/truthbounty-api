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
    const name = job.name as JobName;
    switch (name) {
      case JobName.CLEANUP_SYBIL_HISTORY: {
        const deletedCount = await this.jobsService.cleanupSybilHistory();
        return { deletedCount };
      }
      // V2 Architecture: COMPUTE_SCORES and COMPUTE_REPUTATION jobs removed
      // These jobs previously contained backend-authoritative logic that
      // automatically finalized claims based on backend calculations.
      // In V2, all claim state transitions must come from on-chain events
      // projected by the V2 projectors, not from backend calculations.
      default:
        throw new Error(`Unknown job name: ${job.name}`);
    }
  }
}
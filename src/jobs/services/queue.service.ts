import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class QueueService {
  constructor(
    @InjectQueue('email')
    private readonly emailQueue: Queue,
  ) {}

  async sendWelcomeEmail(email: string) {
    return this.emailQueue.add(
      'welcome-email',
      { email },
      {
        attempts: 5,

        backoff: {
          type: 'exponential',
          delay: 3000,
        },

        removeOnComplete: true,

        removeOnFail: false,
      },
    );
  }
}
import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { JobsService } from './jobs.service';
import { JobName, JobOptions, QueueName, QueueMetrics } from './jobs.types';

@ApiTags('Jobs')
@Controller('admin/jobs')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Post('enqueue')
  @ApiOperation({ summary: 'Enqueue a job' })
  async enqueue(
    @Body('name') name: JobName,
    @Body('data') data: Record<string, unknown>,
    @Body('options') options?: JobOptions,
    @Body('queue') queue?: QueueName,
  ): Promise<{ jobId?: string; queued: boolean }> {
    const job = await this.jobsService.enqueue(
      name,
      data,
      options,
      queue ?? QueueName.DEFAULT,
    );
    return { jobId: job?.id?.toString(), queued: job !== null };
  }

  @Post('retry/:queue')
  @ApiOperation({ summary: 'Retry failed jobs in a queue' })
  async retryFailed(
    @Param('queue') queue: QueueName,
  ): Promise<{ retried: number }> {
    const retried = await this.jobsService.retryFailed(queue);
    return { retried };
  }

  @Post('cancel/:queue')
  @ApiOperation({ summary: 'Cancel a queued job' })
  async cancelJob(
    @Param('queue') queue: QueueName,
    @Body('jobId') jobId: string,
  ): Promise<{ cancelled: boolean }> {
    const cancelled = await this.jobsService.cancelJob(queue, jobId);
    return { cancelled };
  }

  @Post('pause/:queue')
  @ApiOperation({ summary: 'Pause a queue' })
  async pauseQueue(@Param('queue') queue: QueueName): Promise<void> {
    await this.jobsService.pauseQueue(queue);
  }

  @Post('resume/:queue')
  @ApiOperation({ summary: 'Resume a queue' })
  async resumeQueue(@Param('queue') queue: QueueName): Promise<void> {
    await this.jobsService.resumeQueue(queue);
  }

  @Get('metrics/:queue')
  @ApiOperation({ summary: 'Get metrics for a single queue' })
  async getMetrics(@Param('queue') queue: QueueName): Promise<QueueMetrics | null> {
    return this.jobsService.getQueueMetrics(queue);
  }

  @Get('metrics')
  @ApiOperation({ summary: 'Get metrics for all queues' })
  async getAllMetrics(): Promise<QueueMetrics[]> {
    return this.jobsService.getAllQueueMetrics();
  }
}

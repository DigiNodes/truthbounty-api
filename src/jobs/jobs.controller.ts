import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JobsService } from './jobs.service';
import { JobName, JobOptions, QueueName, QueueMetrics } from './jobs.types';
import { AdminGuard } from '../admin/guards/admin.guard';
import { RolesGuard } from '../admin/guards/roles.guard';
import { Roles } from '../admin/decorators/roles.decorator';
import { AdminRole } from '../admin/entities/admin.entity';

@ApiTags('Jobs')
@Controller('admin/jobs')
@UseGuards(AdminGuard, RolesGuard)
@ApiBearerAuth()
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Post('enqueue')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
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
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Retry failed jobs in a queue' })
  async retryFailed(
    @Param('queue') queue: QueueName,
  ): Promise<{ retried: number }> {
    const retried = await this.jobsService.retryFailed(queue);
    return { retried };
  }

  @Post('cancel/:queue')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Cancel a queued job' })
  async cancelJob(
    @Param('queue') queue: QueueName,
    @Body('jobId') jobId: string,
  ): Promise<{ cancelled: boolean }> {
    const cancelled = await this.jobsService.cancelJob(queue, jobId);
    return { cancelled };
  }

  @Post('pause/:queue')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Pause a queue' })
  async pauseQueue(@Param('queue') queue: QueueName): Promise<void> {
    await this.jobsService.pauseQueue(queue);
  }

  @Post('resume/:queue')
  @Roles(AdminRole.SUPER_ADMIN, AdminRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Resume a queue' })
  async resumeQueue(@Param('queue') queue: QueueName): Promise<void> {
    await this.jobsService.resumeQueue(queue);
  }

  @Get('metrics/:queue')
  @Roles(
    AdminRole.SUPER_ADMIN,
    AdminRole.ADMINISTRATOR,
    AdminRole.SECURITY_ANALYST,
    AdminRole.AUDITOR,
  )
  @ApiOperation({ summary: 'Get metrics for a single queue' })
  async getMetrics(
    @Param('queue') queue: QueueName,
  ): Promise<QueueMetrics | null> {
    return this.jobsService.getQueueMetrics(queue);
  }

  @Get('metrics')
  @Roles(
    AdminRole.SUPER_ADMIN,
    AdminRole.ADMINISTRATOR,
    AdminRole.SECURITY_ANALYST,
    AdminRole.AUDITOR,
  )
  @ApiOperation({ summary: 'Get metrics for all queues' })
  async getAllMetrics(): Promise<QueueMetrics[]> {
    return this.jobsService.getAllQueueMetrics();
  }
}

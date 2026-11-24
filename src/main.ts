import { getRuntimeConfig } from './config/runtime-config';
// src/main.ts
import { DiscoveryService, NestFactory } from '@nestjs/core';
import { WorkerHost } from '@nestjs/bullmq';
import { Worker } from 'bullmq';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Server as HttpServer } from 'http';
import { configureApp } from './bootstrap';
import { GracefulShutdownService } from './common/lifecycle/graceful-shutdown.service';

export type ShutdownSignalSource = Pick<NodeJS.Process, 'on'>;

export async function bootstrap(signalSource: ShutdownSignalSource = process) {
  const config = getRuntimeConfig();
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const shutdown = app.get(GracefulShutdownService);
  shutdown.setSchedulerRegistry(app.get(SchedulerRegistry));
  const discovery = app.get(DiscoveryService);
  shutdown.registerStopHook('bullmq-workers', async () => {
    const activeWorkers: Worker[] = [];
    for (const { instance } of discovery.getProviders()) {
      if (!(instance instanceof WorkerHost)) continue;
      try {
        const worker: unknown = instance.worker;
        if (worker instanceof Worker) activeWorkers.push(worker);
      } catch (error) {
        console.warn(
          `Skipping BullMQ worker not initialized before drain: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await Promise.all(activeWorkers.map((worker) => worker.pause()));
  });

  const handleSignal = (signal: string) => {
    console.info(`Received ${signal}; beginning graceful shutdown`);
    void shutdown
      .shutdown(() => app.close())
      .then((result) => {
        process.exitCode = result.failed || result.timedOut ? 1 : 0;
        if (result.timedOut || result.failed) {
          try {
            const server = app.getHttpServer() as HttpServer;
            server.closeAllConnections();
          } catch (error) {
            console.error(
              `Failed to force-close HTTP connections: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          process.exit(1);
        }
      })
      .catch((error: unknown) => {
        console.error(
          `Graceful shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      });
  };
  signalSource.on('SIGTERM', () => handleSignal('SIGTERM'));
  signalSource.on('SIGINT', () => handleSignal('SIGINT'));
  app.use(shutdown.middleware);

  // Validate environment configuration at startup
  const { EnvironmentValidationService } =
    await import('./config/environment-validation.service');
  const envValidationService = app.get(EnvironmentValidationService);
  envValidationService.validateAll();

  configureApp(app);
  if (shutdown.isDraining) return;
  // PORT is supplied by the schema default and validated before Nest creation.
  await app.listen(config.PORT!);
}

if (require.main === module) {
  void bootstrap().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

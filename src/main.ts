import { getRuntimeConfig } from './config/runtime-config';
// src/main.ts
import { NestFactory } from '@nestjs/core';
import { configureApp } from './bootstrap';
export async function bootstrap() {
  const config = getRuntimeConfig();
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Validate environment configuration at startup
  const { EnvironmentValidationService } =
    await import('./config/environment-validation.service');
  const envValidationService = app.get(EnvironmentValidationService);
  await envValidationService.validateAll();

  configureApp(app);
  app.enableShutdownHooks();
  // PORT is supplied by the schema default and validated before Nest creation.
  await app.listen(config.PORT!);
}

if (require.main === module) {
  void bootstrap().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

import { NestFactory } from '@nestjs/core';
import { configureApp } from './bootstrap';

export async function bootstrap() {
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Validate environment configuration at startup
  const { EnvironmentValidationService } = await import('./config/environment-validation.service');
  const envValidationService = app.get(EnvironmentValidationService);
  await envValidationService.validateAll();

  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}

if (require.main === module) {
  void bootstrap().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
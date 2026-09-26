// src/main.ts
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
async function bootstrap() {
    const app = await NestFactory.create(AppModule);

    const config = new DocumentBuilder()
        .setTitle('TruthBounty V2 API')
        .setDescription('Canonical Optimism/EVM V2 indexer, query, and intent relay API contract.')
        .setVersion('2.0.0')
        .addBearerAuth()
        .addTag('Auth', 'SIWE and wallet linkage endpoints')
        .addTag('Projections', 'Read-only event-derived state projections')
        .addTag('Operations', 'Health, backup recovery drills, and system status')
        .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document);

    await app.listen(3000);
}
bootstrap();
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
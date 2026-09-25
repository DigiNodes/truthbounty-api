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
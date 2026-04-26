import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from 'nestjs-pino';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  
  // Use Pino logger for structured JSON logging
  app.useLogger(app.get(Logger));
  
  // Enable strict validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Strip properties that don't have decorators
      forbidNonWhitelisted: true, // Throw error if non-whitelisted properties are present
      transform: true, // Automatically transform payloads to DTO instances
      transformOptions: {
        enableImplicitConversion: true, // Allow implicit type conversion
      },
    }),
  );
  

  // Swagger configuration
  const config = new DocumentBuilder()
    .setTitle('TruthBounty API')
    .setDescription('## Decentralized News Verification Infrastructure\n\nThis API provides endpoints for managing claims, disputes, identity verification, rewards, and blockchain event indexing.\n\n### API Version\n- **Version**: 1.0\n- **Base Path**: `/`\n\n### Authentication\nCurrently, this API does not require authentication. Implement JWT or wallet-based auth as needed.\n\n### Rate Limiting\nSome endpoints are rate-limited using wallet-based throttling.\n\n### Tags\n| Tag | Description |\n|-----|-------------|\n| `identity` | User and wallet identity management |\n| `worldcoin` | Worldcoin ID verification |\n| `claims` | Claim management and evidence |\n| `evidence` | Evidence management with flagging |\n| `disputes` | Dispute creation and resolution |\n| `sybil` | Sybil resistance scoring |\n| `blockchain` | Blockchain event indexing and state |\n| `indexer` | Event indexer management |\n| `rewards` | Reward management |\n| `leaderboard` | User leaderboard rankings |\n| `audit` | Audit log retrieval |\n| `health` | Health check endpoints |')
    .setVersion('1.0')
    .addTag('identity', 'User and wallet identity management')
    .addTag('worldcoin', 'Worldcoin ID verification')
    .addTag('claims', 'Claim management and evidence')
    .addTag('evidence', 'Evidence management with flagging')
    .addTag('disputes', 'Dispute creation and resolution')
    .addTag('sybil', 'Sybil resistance scoring')
    .addTag('blockchain', 'Blockchain event indexing and state')
    .addTag('indexer', 'Event indexer management')
    .addTag('rewards', 'Reward management')
    .addTag('leaderboard', 'User leaderboard rankings')
    .addTag('audit', 'Audit log retrieval')
    .addTag('health', 'Health check endpoints')
    .build();
  
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  app.useGlobalPipes(new ValidationPipe());
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();

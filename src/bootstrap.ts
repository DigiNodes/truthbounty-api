import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';

export function createGlobalValidationPipe() {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: {
      enableImplicitConversion: true,
    },
  });
}

export function configureApp(app: INestApplication) {
  app.useLogger(app.get(Logger));

  const httpAdapter = app.getHttpAdapter().getInstance();

  const trustedProxies =
    process.env.TRUSTED_PROXIES?.split(',')?.map((ip) => ip.trim()) || [];
  if (trustedProxies.length > 0) {
    httpAdapter.set('trust proxy', trustedProxies);
  } else {
    httpAdapter.set('trust proxy', false);
  }

  app.useGlobalPipes(createGlobalValidationPipe());

  const config = new DocumentBuilder()
    .setTitle('TruthBounty API')
    .setDescription('## Decentralized News Verification Infrastructure\n\nThis API provides endpoints for managing claims, disputes, identity verification, rewards, and blockchain event indexing.\n\n### API Version\n- **Version**: 1.0\n- **Base Path**: `/`\n\n### Authentication\nMost mutating endpoints (POST, PATCH, PUT, DELETE) require authentication using wallet signature-based JWT tokens.\n\n#### Authentication Flow:\n1. Request a challenge: `POST /auth/challenge` with your wallet address\n2. Sign the challenge message with your wallet\n3. Login: `POST /auth/login` with address, signature, and message\n4. Use the returned JWT token in the `Authorization` header as `Bearer <token>`\n\nRead-only endpoints (GET) remain public unless specifically protected.\n\n### Rate Limiting\nSome endpoints are rate-limited using wallet-based throttling.')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter JWT token',
        in: 'header',
      },
      'JWT-auth',
    )
    .addTag('auth', 'Authentication with wallet signature')
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
    .addTag('audit', 'Audit logging, search, compliance reporting, and retention management')
    .addTag('health', 'Health check endpoints')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);
}
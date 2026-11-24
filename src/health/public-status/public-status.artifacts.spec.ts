import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  PUBLIC_STATUS_SCENARIOS,
  SCENARIO_POLICY,
} from '../../../test/fixtures/contracts/public-status.scenarios';
import { PUBLIC_STATUS_SCHEMA_VERSION } from './public-status.dto';
import { PublicStatusController } from './public-status.controller';
import { projectPublicStatus } from './public-status.projector';
import { PublicStatusRateLimitGuard } from './public-status-rate-limit.guard';
import { PublicStatusService } from './public-status.service';

/**
 * Published artifacts for UX-BE-001:
 *   docs/public-status/openapi.json   OpenAPI 3 document for GET /status/public
 *   docs/public-status/fixtures.json  Frontend fixtures, one per scenario
 *
 * This spec fails if the committed artifacts drift from the code. Regenerate:
 *   UPDATE_PUBLIC_STATUS_ARTIFACTS=1 npx jest public-status.artifacts
 */
const DOCS_DIR = join(__dirname, '../../../docs/public-status');
const UPDATE = process.env.UPDATE_PUBLIC_STATUS_ARTIFACTS === '1';

const PROTECTED_FIELD_NAMES = [
  'dependencies',
  'diagnostics',
  'responseTimeMs',
  'failureReason',
  'failureReasonCode',
  'critical',
  'uptime',
  'environment',
  'memoryUsage',
  'snapshot',
  'alertThresholds',
  'runbookUrl',
];

function checkArtifact(file: string, actual: unknown): void {
  const path = join(DOCS_DIR, file);
  const serialized = `${JSON.stringify(actual, null, 2)}\n`;
  if (UPDATE) {
    if (!existsSync(DOCS_DIR)) mkdirSync(DOCS_DIR, { recursive: true });
    writeFileSync(path, serialized);
  }
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(
    JSON.parse(serialized),
  );
}

describe('public status published artifacts (UX-BE-001)', () => {
  let app: INestApplication;
  let document: ReturnType<typeof SwaggerModule.createDocument>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PublicStatusController],
      providers: [
        {
          provide: PublicStatusService,
          useValue: { getSnapshot: jest.fn(), getOptions: jest.fn() },
        },
        PublicStatusRateLimitGuard,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('TruthBounty Public Status')
        .setDescription(
          'Sanitized public service-status projection (UX-BE-001).',
        )
        .setVersion(PUBLIC_STATUS_SCHEMA_VERSION)
        .build(),
    );
  });

  afterAll(() => app?.close());

  it('publishes the OpenAPI document', () => {
    expect(document.paths['/status/public']?.get).toBeDefined();
    checkArtifact('openapi.json', document);
  });

  it('keeps the public schema structurally separate from protected health fields', () => {
    const schemas = document.components!.schemas!;
    const publicSchemas = Object.keys(schemas).filter((n) =>
      n.startsWith('Public'),
    );
    expect(publicSchemas).toEqual(
      expect.arrayContaining([
        'PublicStatusResponseDto',
        'PublicComponentStatusDto',
        'PublicObservationDto',
        'PublicReleaseManifestDto',
        'PublicChainProgressDto',
        'PublicStatusCacheDto',
      ]),
    );
    for (const name of publicSchemas) {
      const props = Object.keys((schemas[name] as any).properties ?? {});
      for (const forbidden of PROTECTED_FIELD_NAMES) {
        expect(props).not.toContain(forbidden);
      }
    }
  });

  it('publishes frontend fixtures that match the projector output', () => {
    const fixtures = Object.fromEntries(
      Object.entries(PUBLIC_STATUS_SCENARIOS).map(([name, inputs]) => [
        name,
        projectPublicStatus(inputs, SCENARIO_POLICY),
      ]),
    );
    checkArtifact('fixtures.json', {
      schemaVersion: PUBLIC_STATUS_SCHEMA_VERSION,
      scenarios: fixtures,
    });
  });
});

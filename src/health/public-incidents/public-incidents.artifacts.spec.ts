import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  FORBIDDEN_INCIDENT_SUBSTRINGS,
  PAGINATED_INCIDENT_SET,
  RAW_DRAFT_INCIDENT,
  RAW_MONITORING_INCIDENT,
  RAW_RESOLVED_INCIDENT,
  RAW_STALE_INCIDENT,
  RAW_UNTRUSTED_AND_DRAFT_INCIDENT,
  SCENARIO_NOW,
  SCENARIO_POLICY,
} from '../../../test/fixtures/contracts/public-incidents.scenarios';
import {
  PUBLIC_INCIDENTS_SCHEMA_VERSION,
  PublicIncidentDetailDto,
} from './public-incidents.dto';
import { PublicIncidentController } from './public-incidents.controller';
import { PublicIncidentRateLimitGuard } from './public-incidents-rate-limit.guard';
import { PublicIncidentService } from './public-incidents.service';
import {
  projectPublicIncidentDetail,
  projectPublicIncidentList,
} from './public-incidents.projector';

/**
 * Published artifacts for UX-BE-002:
 *   docs/public-incidents/openapi.json   OpenAPI 3 document for GET /status/incidents
 *   docs/public-incidents/fixtures.json  Frontend fixtures, one per scenario
 *
 * This spec fails if the committed artifacts drift from the code. Regenerate:
 *   UPDATE_PUBLIC_INCIDENTS_ARTIFACTS=1 npx jest public-incidents.artifacts
 */
const DOCS_DIR = join(__dirname, '../../../docs/public-incidents');
const UPDATE = process.env.UPDATE_PUBLIC_INCIDENTS_ARTIFACTS === '1';

const PROTECTED_INCIDENT_FIELD_NAMES = [
  'investigationNotes',
  'reportedBy',
  'assignedTo',
  'relatedEntityType',
  'relatedEntityId',
  'approvedBy',
  'rootCauseInternal',
  'reportAuthor',
  'isDraft',
  'isApproved',
];

function checkArtifact(file: string, actual: unknown): void {
  const path = join(DOCS_DIR, file);
  const serialized = `${JSON.stringify(actual, null, 2)}\n`;
  if (UPDATE || !existsSync(path)) {
    if (!existsSync(DOCS_DIR)) mkdirSync(DOCS_DIR, { recursive: true });
    writeFileSync(path, serialized);
  }
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(
    JSON.parse(serialized),
  );
}

describe('public incidents published artifacts (UX-BE-002)', () => {
  let app: INestApplication;
  let document: ReturnType<typeof SwaggerModule.createDocument>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PublicIncidentController],
      providers: [
        {
          provide: PublicIncidentService,
          useValue: {
            findAll: jest.fn(),
            findById: jest.fn(),
            getOptions: jest.fn().mockReturnValue(SCENARIO_POLICY),
          },
        },
        PublicIncidentRateLimitGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('TruthBounty Public Incidents')
        .setDescription(
          'Sanitized public incident projections and publication audit history (UX-BE-002).',
        )
        .setVersion(PUBLIC_INCIDENTS_SCHEMA_VERSION)
        .build(),
    );
  });

  afterAll(() => app?.close());

  it('publishes the OpenAPI document for public incident endpoints', () => {
    expect(document.paths['/status/incidents']?.get).toBeDefined();
    expect(document.paths['/status/incidents/{incidentId}']?.get).toBeDefined();
    checkArtifact('openapi.json', document);
  });

  it('keeps public incident schemas structurally separate from protected admin models', () => {
    const schemas = document.components!.schemas!;
    const publicSchemas = Object.keys(schemas).filter((n) =>
      n.startsWith('PublicIncident'),
    );

    expect(publicSchemas).toEqual(
      expect.arrayContaining([
        'PublicIncidentListResponseDto',
        'PublicIncidentDetailDto',
        'PublicIncidentSummaryDto',
        'PublicIncidentHistoryRecordDto',
        'PublicIncidentLinkDto',
        'PublicIncidentPaginationMetaDto',
      ]),
    );

    for (const name of publicSchemas) {
      const props = Object.keys((schemas[name] as any).properties ?? {});
      for (const forbidden of PROTECTED_INCIDENT_FIELD_NAMES) {
        expect(props).not.toContain(forbidden);
      }
    }
  });

  it('publishes frontend fixtures for all required scenarios', () => {
    // 1. Monitoring scenario
    const monitoring = projectPublicIncidentDetail(RAW_MONITORING_INCIDENT);

    // 2. Resolved scenario
    const resolved = projectPublicIncidentDetail(RAW_RESOLVED_INCIDENT);

    // 3. Stale scenario
    const staleList = projectPublicIncidentList(
      [RAW_STALE_INCIDENT],
      1,
      1,
      10,
      SCENARIO_NOW,
      SCENARIO_POLICY,
    );

    // 4. Unavailable scenario (empty/safe fail-closed projection)
    const unavailableList = projectPublicIncidentList(
      [],
      0,
      1,
      10,
      SCENARIO_NOW,
      SCENARIO_POLICY,
    );

    // 5. Pagination scenario (page 1, limit 2, total 5)
    const paginationList = projectPublicIncidentList(
      PAGINATED_INCIDENT_SET.slice(0, 2),
      PAGINATED_INCIDENT_SET.length,
      1,
      2,
      SCENARIO_NOW,
      SCENARIO_POLICY,
    );

    // 6. Unknown ID scenario (simulated 404 response payload)
    const unknownId = {
      statusCode: 404,
      message: 'Incident with ID inc-unknown-uuid not found',
      error: 'Not Found',
    };

    // 7. Publication history scenario
    const publicationHistory = (resolved as PublicIncidentDetailDto).publicationHistory;

    // 8. Sanitized untrusted Markdown & draft omission
    const draftOmitted = projectPublicIncidentDetail(RAW_DRAFT_INCIDENT);
    expect(draftOmitted).toBeNull();

    const sanitizedDetail = projectPublicIncidentDetail(
      RAW_UNTRUSTED_AND_DRAFT_INCIDENT,
    );

    const fixtures = {
      schemaVersion: PUBLIC_INCIDENTS_SCHEMA_VERSION,
      scenarios: {
        monitoring,
        resolved,
        stale: staleList,
        unavailable: unavailableList,
        pagination: paginationList,
        unknownId,
        publicationHistory,
        sanitizedUntrustedAndRedacted: sanitizedDetail,
      },
    };

    const fixtureString = JSON.stringify(fixtures);
    for (const forbidden of FORBIDDEN_INCIDENT_SUBSTRINGS) {
      expect(fixtureString).not.toContain(forbidden);
    }

    checkArtifact('fixtures.json', fixtures);
  });
});

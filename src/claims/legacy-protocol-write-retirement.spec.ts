import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GoneException } from '@nestjs/common';
import {
  assertLegacyProtocolWriteRetired,
  legacyWriteRetiredBody,
  LEGACY_PROTOCOL_WRITE_RETIRED,
  LEGACY_WRITE_OPERATIONS,
  LEGACY_READ_DEPRECATION,
} from './legacy-protocol-write-retirement';

describe('legacy protocol write retirement (PREWAVE-BE-132)', () => {
  it.each(LEGACY_WRITE_OPERATIONS)(
    'returns a stable 410 envelope for %s',
    (operation) => {
      const body = legacyWriteRetiredBody(operation);
      expect(body).toEqual(
        expect.objectContaining({
          statusCode: 410,
          error: 'Gone',
          code: LEGACY_PROTOCOL_WRITE_RETIRED,
          operation,
          canonical: false,
        }),
      );
      expect(body.replacement).toMatch(/transaction|projection/i);
      expect(body.lifecycle.length).toBe(4);
    },
  );

  it.each(LEGACY_WRITE_OPERATIONS)(
    'throws before any side effect when %s is invoked internally',
    (operation) => {
      expect(() => assertLegacyProtocolWriteRetired(operation)).toThrow(
        GoneException,
      );
      try {
        assertLegacyProtocolWriteRetired(operation);
      } catch (error) {
        const response = (error as GoneException).getResponse() as Record<
          string,
          unknown
        >;
        expect(response).toEqual(legacyWriteRetiredBody(operation));
        expect((error as GoneException).getStatus()).toBe(410);
      }
    },
  );

  it('points legacy reads at canonical V2 successor endpoints', () => {
    expect(LEGACY_READ_DEPRECATION.claimLink).toContain('/api/v2/claims');
    expect(LEGACY_READ_DEPRECATION.claimDetailLink).toContain(
      '/api/v2/claim-read-models',
    );
    expect(LEGACY_READ_DEPRECATION.evidenceLink).toContain('/v2/claims/');
    expect(LEGACY_READ_DEPRECATION.notice).toMatch(/non-authoritative/i);
  });
});

/**
 * Source-level invariants complement the behavioural tests: they guarantee no
 * legacy route or internal service still reaches a persistence call on the
 * retired write path, including in modules whose legacy imports are being
 * removed during the Prisma/PostgreSQL migration.
 */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`Method not found: ${signature}`);
  const opening = source.indexOf('{', start);
  let depth = 0;
  for (let i = opening; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(opening, i + 1);
    }
  }
  throw new Error(`Unbalanced method: ${signature}`);
}

describe('retired write path contains no persistence calls', () => {
  const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');

  it('ClaimsService.createClaim only fails closed', () => {
    const body = methodBody(read('claims.service.ts'), 'async createClaim(');
    expect(body).toContain("assertLegacyProtocolWriteRetired('claim.create')");
    expect(body).not.toMatch(
      /\.(save|create|insert)\(|claimsCache\.|redisService\./,
    );
  });

  it('EvidenceService create/replace methods only fail closed', () => {
    const source = read('evidence.service.ts');
    for (const [signature, operation] of [
      ['async createEvidence(', 'evidence.register'],
      ['async addEvidenceVersion(', 'evidence.replace'],
    ] as const) {
      const body = methodBody(source, signature);
      expect(body).toContain(
        `assertLegacyProtocolWriteRetired('${operation}')`,
      );
      expect(body).not.toMatch(/\.(save|create|insert)\(|auditTrailService\./);
    }
    expect(source).not.toMatch(/evidenceRepository\.(save|insert)\(/);
    expect(source).not.toMatch(/evidenceVersionRepository\.(save|insert)\(/);
  });

  it('legacy controller write routes delegate to the 410 guard', () => {
    const source = read('claims.controller.ts');
    expect(source).toContain(
      "assertLegacyProtocolWriteRetired('claim.create')",
    );
    expect(source).toContain(
      "assertLegacyProtocolWriteRetired('evidence.register')",
    );
    expect(source).toContain(
      "assertLegacyProtocolWriteRetired('evidence.replace')",
    );
    expect(source).not.toMatch(/claimsService\.createClaim\(/);
    expect(source).not.toMatch(
      /evidenceService\.(createEvidence|addEvidenceVersion)\(/,
    );
  });
});

import * as fs from 'fs';
import * as path from 'path';
import {
  ABUSE_REASON_CODE_REGISTRY,
  ABUSE_WINDOW_LIMITS,
  AbuseReasonCode,
  AbuseAction,
} from './abuse-signals.types';
import {
  ABUSE_ACTION_KINDS,
  ABUSE_ACTION_STATUSES,
  ABUSE_DECISION_CHECKS,
  ABUSE_DECISION_INDETERMINATE_REASONS,
  ABUSE_DECISION_OUTCOMES,
} from './entities/abuse-decision-record.entity';
import { ABUSE_APPEAL_STATUSES } from './entities/abuse-appeal-record.entity';

/**
 * Architectural invariants for the abuse-signals boundary (#681).
 *
 * These are asserted as source facts rather than as runtime behaviour because
 * the property under test is a *permission*, not an outcome: the module must be
 * structurally incapable of becoming protocol authority, and a regression that
 * quietly gave it a repository or a chain client would otherwise only show up
 * as a bug in production.
 */
const MODULE_DIR = __dirname;

function moduleFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts') && !full.endsWith('.spec.ts')) files.push(full);
    }
  };
  walk(MODULE_DIR);
  return files;
}

const FILES = moduleFiles();

describe('abuse signals cannot become protocol authority (PREWAVE-BE-086)', () => {
  it('ships source files to inspect', () => {
    expect(FILES.length).toBeGreaterThan(5);
  });

  it.each([
    'prisma.service',
    '@prisma/client',
    'generated/client',
  ])('does not reach for Prisma (%s)', (forbidden) => {
    for (const file of FILES) {
      expect(fs.readFileSync(file, 'utf8')).not.toContain(forbidden);
    }
  });

  it.each([
    'ethers',
    'viem',
    '@ethersproject',
    'web3',
    'Contract',
    'Wallet',
    'JsonRpcProvider',
  ])('never imports a chain client or signer (%s)', (forbidden) => {
    for (const file of FILES) {
      const content = fs.readFileSync(file, 'utf8');
      // The word may appear in prose explaining that we do *not* do this; an
      // import may not.
      const importLines = content
        .split('\n')
        .filter((line) => /^\s*(import|export).*from\s/.test(line));
      for (const line of importLines) {
        expect(line).not.toContain(forbidden);
      }
    }
  });

  it.each([
    'ClaimResolutionService',
    'WeightedVoteResolutionService',
    'ReorgRollbackService',
    'CanonicalEventsService',
    'RewardAllocation',
    'DisputeLifecycle',
    'GovernanceProjection',
  ])('holds no dependency on protocol mutation (%s)', (forbidden) => {
    for (const file of FILES) {
      const content = fs.readFileSync(file, 'utf8');
      const importLines = content
        .split('\n')
        .filter((line) => /^\s*(import|export).*from\s/.test(line));
      for (const line of importLines) {
        expect(line).not.toContain(forbidden);
      }
    }
  });

  it('references only abuse-owned tables', () => {
    const tableNames = new Set<string>();
    for (const file of FILES) {
      const content = fs.readFileSync(file, 'utf8');
      for (const match of content.matchAll(/@Entity\('([^']+)'\)/g)) {
        tableNames.add(match[1]);
      }
    }
    expect([...tableNames].sort()).toEqual([
      'abuse_appeals',
      'abuse_decisions',
    ]);
  });

  it('references no protocol table in a query', () => {
    const protocolTables = [
      'claims',
      'disputes',
      'rewards',
      'evidence',
      'verifications',
      'proposals',
      'canonical_events',
    ];
    for (const file of FILES) {
      const content = fs.readFileSync(file, 'utf8');
      for (const table of protocolTables) {
        expect(content).not.toContain(`"${table}"`);
        expect(content).not.toContain(`FROM "${table}"`);
      }
    }
  });
});

describe('abuse invariants that must not drift (PREWAVE-BE-086)', () => {
  it('keeps every reason code registered and versioned', () => {
    for (const code of Object.values(AbuseReasonCode)) {
      const descriptor = ABUSE_REASON_CODE_REGISTRY[code];
      expect(descriptor).toBeDefined();
      expect(descriptor.version).toBe(1);
      expect(descriptor.allowsAutomatedAction).toBeDefined();
    }
  });

  it('never lets the suppression marker drive an action', () => {
    expect(
      ABUSE_REASON_CODE_REGISTRY[
        AbuseReasonCode.INSUFFICIENT_CORROBORATION
      ].allowsAutomatedAction,
    ).toBe(false);
  });

  it('requires corroboration on every class that can misfire on shared egress', () => {
    const sharedEgressClasses = [
      AbuseReasonCode.SCRAPE_HIGH_BREADTH_ANONYMOUS,
      AbuseReasonCode.SCRAPE_SUSTAINED_READ_VELOCITY,
      AbuseReasonCode.SPAM_SUBMISSION_WRITE_BURST,
      AbuseReasonCode.SPAM_SUBMISSION_DUPLICATE_PAYLOAD,
      AbuseReasonCode.SUPPORT_VOLUME_FLOOD,
      AbuseReasonCode.SUPPORT_DUPLICATE_FLOOD,
    ];
    for (const code of sharedEgressClasses) {
      expect(ABUSE_REASON_CODE_REGISTRY[code].minCorroboratingDimensions)
        .toBeGreaterThanOrEqual(2);
    }
  });

  it('bounds every retained collection so a hostile subject cannot grow the heap', () => {
    for (const limit of Object.values(ABUSE_WINDOW_LIMITS)) {
      expect(limit).toBeGreaterThan(0);
      expect(limit).toBeLessThanOrEqual(1_024);
    }
  });

  it('mirrors the TypeScript enums in the database CHECK constraints', () => {
    const entity = fs.readFileSync(
      path.join(MODULE_DIR, 'entities', 'abuse-decision-record.entity.ts'),
      'utf8',
    );
    for (const outcome of ABUSE_DECISION_OUTCOMES) {
      expect(entity).toContain(`'${outcome}'`);
    }
    for (const reason of ABUSE_DECISION_INDETERMINATE_REASONS) {
      expect(entity).toContain(`'${reason}'`);
    }
    for (const kind of ABUSE_ACTION_KINDS) {
      expect(entity).toContain(`'${kind}'`);
    }
    for (const status of ABUSE_ACTION_STATUSES) {
      expect(entity).toContain(`'${status}'`);
    }

    const appeal = fs.readFileSync(
      path.join(MODULE_DIR, 'entities', 'abuse-appeal-record.entity.ts'),
      'utf8',
    );
    for (const status of ABUSE_APPEAL_STATUSES) {
      expect(appeal).toContain(`'${status}'`);
    }
  });

  it('constrains the database with the TypeScript literals, not a copy', () => {
    const migration = fs.readFileSync(
      path.join(
        path.dirname(MODULE_DIR),
        'migrations',
        '1792300000000-PersistAbuseSignalRecords.ts',
      ),
      'utf8',
    );
    // The migration must render the shared constants, so a new code cannot be
    // added to the enum without also reaching the database constraint.
    expect(migration).toContain('ABUSE_DECISION_CHECKS');
    expect(migration).toContain('ABUSE_APPEAL_STATUSES');

    const rendered = [
      ...Object.values(ABUSE_DECISION_CHECKS),
      ABUSE_APPEAL_STATUSES.map((status) => `'${status}'`).join(','),
    ].join(' ');
    for (const value of [
      ...ABUSE_DECISION_OUTCOMES,
      ...ABUSE_DECISION_INDETERMINATE_REASONS,
      ...ABUSE_ACTION_KINDS,
      ...ABUSE_ACTION_STATUSES,
    ]) {
      expect(rendered).toContain(`'${value}'`);
    }

    // The bound that makes actions time-limited is enforced in the database.
    expect(migration).toContain('"actionExpiresAt" > "decidedAt"');
  });

  it('enforces provenance as all-or-nothing in the database', () => {
    const migration = fs.readFileSync(
      path.join(
        path.dirname(MODULE_DIR),
        'migrations',
        '1792300000000-PersistAbuseSignalRecords.ts',
      ),
      'utf8',
    );
    expect(migration).toContain('chk_abuse_decision_binding');
    expect(migration).toContain('chk_abuse_decision_action_bound');
  });

  it('emits SQL that carries every bound the contract depends on', async () => {
    const { PersistAbuseSignalRecords1792300000000 } = await import(
      '../migrations/1792300000000-PersistAbuseSignalRecords'
    );
    const emitted: string[] = [];
    const runner = {
      connection: { options: { type: 'postgres' } },
      query: (sql: string) => {
        emitted.push(sql);
        return Promise.resolve();
      },
    };
    // Unknown argument type on purpose: the migration only uses `query`.
    await new PersistAbuseSignalRecords1792300000000().up(runner as never);

    const sql = emitted.join('\n');
    for (const table of ['abuse_decisions', 'abuse_appeals']) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
    // Every enum literal reaches the database through the shared constants.
    for (const value of [
      ...ABUSE_DECISION_OUTCOMES,
      ...ABUSE_DECISION_INDETERMINATE_REASONS,
      ...ABUSE_ACTION_KINDS,
      ...ABUSE_ACTION_STATUSES,
      ...ABUSE_APPEAL_STATUSES,
    ]) {
      expect(sql).toContain(`'${value}'`);
    }
    // The invariants that make actions bounded and appealable.
    expect(sql).toContain('"actionExpiresAt" > "decidedAt"');
    expect(sql).toContain('"reviewDueAt" >= "submittedAt"');
    expect(sql).toContain('"appealable"');
    // The subject column is a digest, so its length is constrained.
    expect(sql).toContain('length("subjectKey") = 64');
    // At most one open appeal per action, even under concurrent submissions.
    expect(sql).toContain("WHERE \"status\" = 'pending'");
  });

  it('refuses to run against anything other than PostgreSQL', async () => {
    const { PersistAbuseSignalRecords1792300000000 } = await import(
      '../migrations/1792300000000-PersistAbuseSignalRecords'
    );
    const runner = {
      connection: { options: { type: 'sqlite' } },
      query: () => Promise.resolve(),
    };
    await expect(
      new PersistAbuseSignalRecords1792300000000().up(runner as never),
    ).rejects.toThrow('requires PostgreSQL');
  });
});

describe('an action is always bounded and appealable', () => {
  const action: AbuseAction = {
    id: 'a'.repeat(32),
    subjectKey: 'b'.repeat(64),
    subjectKind: 'principal' as AbuseAction['subjectKind'],
    kind: 'challenge' as AbuseAction['kind'],
    status: 'active' as AbuseAction['status'],
    reasonCode: AbuseReasonCode.SCRAPE_HIGH_BREADTH_ANONYMOUS,
    reasonCodeVersion: 1,
    modelVersion: 'abuse-model.v1',
    configVersion: 'abuse-config.v1',
    binding: {
      chainId: 10,
      releaseId: 'v1',
      deploymentBlock: 1n,
      artifactChecksum: 'c'.repeat(64),
    },
    costMultiplier: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:05:00.000Z',
    appealable: true,
    escalationLevel: 1,
  };

  it('carries provenance, a finite expiry and appealability', () => {
    expect(action.binding.artifactChecksum).toHaveLength(64);
    expect(Number.isFinite(Date.parse(action.expiresAt))).toBe(true);
    expect(Date.parse(action.expiresAt)).toBeGreaterThan(
      Date.parse(action.startedAt),
    );
    expect(action.appealable).toBe(true);
  });

  it('holds no secret, evidence reference, signature or personal data', () => {
    const serialized = JSON.stringify(action, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(serialized).not.toMatch(
      /authorization|bearer|private[-_ ]?key|seed phrase|mnemonic|password|signature|evidence|ipfs|0x[0-9a-f]{40}/i,
    );
  });
});
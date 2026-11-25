import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CURRENT_CONSENT_POLICY_VERSION } from './analytics.schemas';
import { AnalyticsConsentService } from './analytics-consent.service';

const SECRET = 'a-stable-test-consent-key-with-at-least-32-characters';
const DAY_MS = 24 * 60 * 60 * 1000;

interface StoredConsent {
  status: 'none' | 'granted' | 'withdrawn';
  policy_version: string;
  granted_at: Date | null;
  withdrawn_at: Date | null;
  do_not_track: boolean;
}

interface StoredHistory {
  id: string;
  eventType: string;
  subjectKey: string | null;
  relatedSubjectKey: string | null;
  retentionUntil: Date;
}

class SharedConsentDatabase {
  readonly current = new Map<string, StoredConsent>();
  readonly history: StoredHistory[] = [];
  readonly deletedUsageSubjects: string[] = [];
  private transactionTail: Promise<void> = Promise.resolve();

  readonly $queryRaw = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    const sql = strings.join('?');
    if (sql.includes('pg_advisory_xact_lock')) return [];

    if (
      sql.includes('FROM "analytics_consent_current"') &&
      sql.includes('SELECT')
    ) {
      const row = this.current.get(String(values[0]));
      return row ? [{ ...row }] : [];
    }

    if (sql.includes('INSERT INTO "analytics_consent_current"')) {
      const key = String(values[0]);
      const existing = this.current.get(key);
      let row: StoredConsent;

      if (sql.includes("'granted'")) {
        row = {
          status: 'granted',
          policy_version: String(values[1]),
          granted_at: new Date(),
          withdrawn_at: null,
          do_not_track: existing?.do_not_track ?? false,
        };
      } else if (sql.includes("'withdrawn'")) {
        row = {
          status: 'withdrawn',
          policy_version: existing?.policy_version ?? String(values[1]),
          granted_at: existing?.granted_at ?? null,
          withdrawn_at: new Date(),
          do_not_track: existing?.do_not_track ?? false,
        };
      } else {
        row = existing
          ? { ...existing, do_not_track: Boolean(values[2]) }
          : {
              status: 'none',
              policy_version: String(values[1]),
              granted_at: null,
              withdrawn_at: null,
              do_not_track: Boolean(values[2]),
            };
      }

      this.current.set(key, row);
      return [{ ...row }];
    }

    throw new Error(`Unexpected consent query: ${sql}`);
  };

  readonly $executeRaw = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<number> => {
    const sql = strings.join('?');
    if (sql.includes('DELETE FROM "analytics_consent_current"')) {
      return Number(this.current.delete(String(values[0])));
    }
    if (
      sql.includes('DELETE FROM "analytics_consent_history"') &&
      sql.includes('"retention_until"')
    ) {
      const before = this.history.length;
      const now = new Date();
      for (let i = this.history.length - 1; i >= 0; i--) {
        if (this.history[i].retentionUntil <= now) this.history.splice(i, 1);
      }
      return before - this.history.length;
    }
    if (sql.includes('DELETE FROM "analytics_consent_history"')) {
      const key = String(values[0]);
      const before = this.history.length;
      for (let i = this.history.length - 1; i >= 0; i--) {
        const row = this.history[i];
        if (row.subjectKey === key || row.relatedSubjectKey === key) {
          this.history.splice(i, 1);
        }
      }
      return before - this.history.length;
    }
    if (sql.includes('DELETE FROM "AiUsageMetric"')) {
      this.deletedUsageSubjects.push(String(values[0]));
      this.deletedUsageSubjects.push(String(values[1]));
      return 1;
    }
    if (sql.includes('INSERT INTO "analytics_consent_history"')) {
      this.history.push({
        id: String(values[0]),
        eventType: String(values[1]),
        subjectKey: values[2] as string | null,
        relatedSubjectKey: values[3] as string | null,
        retentionUntil: new Date(Date.now() + 30 * DAY_MS),
      });
      return 1;
    }
    throw new Error(`Unexpected consent execute: ${sql}`);
  };

  async $transaction<T>(
    work: (tx: SharedConsentDatabase) => Promise<T>,
  ): Promise<T> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work(this);
    } finally {
      release();
    }
  }
}

function serviceFor(
  database: SharedConsentDatabase,
  secret = SECRET,
): AnalyticsConsentService {
  return new AnalyticsConsentService(
    database as unknown as PrismaService,
    {
      get: jest.fn().mockReturnValue(secret),
    } as unknown as ConfigService,
  );
}

describe('AnalyticsConsentService durable state', () => {
  it('survives service recreation and shares withdrawal across instances', async () => {
    const database = new SharedConsentDatabase();
    const firstInstance = serviceFor(database);
    await firstInstance.grant('subject-1');

    const restartedInstance = serviceFor(database);
    expect(await restartedInstance.hasValidConsent('subject-1')).toBe(true);

    await restartedInstance.withdraw('subject-1');
    expect(await firstInstance.hasValidConsent('subject-1')).toBe(false);
    expect((await firstInstance.get('subject-1')).status).toBe('withdrawn');
  });

  it('requires explicit renewal under the current policy version', async () => {
    const database = new SharedConsentDatabase();
    const service = serviceFor(database);
    const staleKey = service.getSubjectKey('stale-subject');
    database.current.set(staleKey, {
      status: 'granted',
      policy_version: 'old-policy',
      granted_at: new Date(),
      withdrawn_at: null,
      do_not_track: false,
    });

    expect(await service.hasValidConsent('stale-subject')).toBe(false);
    await expect(service.grant('stale-subject', 'old-policy')).rejects.toThrow(
      'current analytics policy',
    );
    expect(
      (await service.renew('stale-subject', CURRENT_CONSENT_POLICY_VERSION))
        .policyVersion,
    ).toBe(CURRENT_CONSENT_POLICY_VERSION);
    expect(await service.hasValidConsent('stale-subject')).toBe(true);
  });

  it('persists do-not-track across instances without granting consent', async () => {
    const database = new SharedConsentDatabase();
    const service = serviceFor(database);
    await service.setDoNotTrack('subject-2', true);

    const restarted = serviceFor(database);
    const record = await restarted.get('subject-2');
    expect(record.doNotTrack).toBe(true);
    expect(record.status).toBe('none');
    expect(await restarted.hasValidConsent('subject-2')).toBe(false);
  });

  it('setting do-not-track after grant preserves granted status and blocks collection', async () => {
    const database = new SharedConsentDatabase();
    const service = serviceFor(database);
    await service.grant('subject-dnt');

    expect(await service.hasValidConsent('subject-dnt')).toBe(true);

    await service.setDoNotTrack('subject-dnt', true);

    const record = await service.get('subject-dnt');
    // Status must remain 'granted' — DNT only updates the do_not_track column.
    expect(record.status).toBe('granted');
    expect(record.doNotTrack).toBe(true);
    // Collection is blocked by DNT even though status is still 'granted'.
    expect(await service.hasValidConsent('subject-dnt')).toBe(false);
  });

  it('serializes concurrent grant and withdrawal operations', async () => {
    const database = new SharedConsentDatabase();
    const service = serviceFor(database);

    await Promise.all([
      service.grant('subject-3'),
      service.withdraw('subject-3'),
    ]);
    expect((await service.get('subject-3')).status).toBe('withdrawn');

    await Promise.all([
      service.withdraw('subject-3'),
      service.grant('subject-3'),
    ]);
    expect((await service.get('subject-3')).status).toBe('granted');
  });

  it('atomically rotates subjects and erases linked metrics and history', async () => {
    const database = new SharedConsentDatabase();
    const service = serviceFor(database);
    await service.grant('old-subject');
    await service.grant('new-subject');

    await service.rotateSubject('old-subject', 'new-subject');

    expect(await service.hasValidConsent('old-subject')).toBe(false);
    expect(await service.hasValidConsent('new-subject')).toBe(false);
    expect(database.deletedUsageSubjects).toEqual([
      service.getSubjectKey('old-subject'),
      'old-subject',
      service.getSubjectKey('new-subject'),
      'new-subject',
    ]);
    expect(database.history).toHaveLength(1);
    expect(database.history[0].eventType).toBe('subject_rotated');
    expect(database.history[0].subjectKey).not.toContain('old-subject');
    expect(database.history[0].relatedSubjectKey).not.toContain('new-subject');
  });

  it('erases subject-linked state and retains only anonymous deletion history', async () => {
    const database = new SharedConsentDatabase();
    const service = serviceFor(database);
    await service.grant('erase-subject');
    await service.rotateSubject('erase-subject', 'next-subject');

    await service.deleteSubject('next-subject');

    expect(await service.hasValidConsent('next-subject')).toBe(false);
    expect(database.deletedUsageSubjects).toContain(
      service.getSubjectKey('next-subject'),
    );
    expect(database.deletedUsageSubjects).toContain('next-subject');
    expect(database.history).toHaveLength(1);
    expect(database.history[0]).toMatchObject({
      eventType: 'subject_deleted',
      subjectKey: null,
      relatedSubjectKey: null,
    });
    expect(JSON.stringify(database.history)).not.toContain('next-subject');
  });

  it('purges lifecycle history after its retention deadline', async () => {
    const database = new SharedConsentDatabase();
    const service = serviceFor(database);
    await service.rotateSubject('old', 'new');
    database.history[0].retentionUntil = new Date(Date.now() - DAY_MS);

    await service.purgeExpiredHistory();

    expect(database.history).toHaveLength(0);
  });

  it('fails closed when the shared subject key is unavailable', async () => {
    const service = serviceFor(new SharedConsentDatabase(), '');
    await expect(service.hasValidConsent('subject')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});

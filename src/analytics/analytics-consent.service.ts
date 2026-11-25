import { createHmac, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { Prisma } from '../generated/client/client';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsConsentRecord, ConsentStatus } from './analytics.types';
import { CURRENT_CONSENT_POLICY_VERSION } from './analytics.schemas';

const HISTORY_RETENTION_DAYS = 30;

interface ConsentRow {
  status: ConsentStatus;
  policy_version: string;
  granted_at: Date | null;
  withdrawn_at: Date | null;
  do_not_track: boolean;
}

export type ConsentCollectionResult<T> =
  | { allowed: true; value: T }
  | { allowed: false; reason: 'no_consent' | 'withdrawn' | 'dnt' };

@Injectable()
export class AnalyticsConsentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async get(subjectId: string): Promise<AnalyticsConsentRecord> {
    const subjectKey = this.subjectKey(subjectId);
    const rows = await this.prisma.$queryRaw<ConsentRow[]>`
      SELECT "status", "policy_version", "granted_at", "withdrawn_at", "do_not_track"
      FROM "analytics_consent_current"
      WHERE "subject_key" = ${subjectKey}
      LIMIT 1
    `;
    return this.toRecord(rows[0]);
  }

  async grant(
    subjectId: string,
    policyVersion = CURRENT_CONSENT_POLICY_VERSION,
  ): Promise<AnalyticsConsentRecord> {
    this.assertCurrentPolicy(policyVersion);
    const subjectKey = this.subjectKey(subjectId);

    return this.prisma.$transaction(async (tx) => {
      await this.lockSubjects(tx, [subjectKey]);
      const rows = await tx.$queryRaw<ConsentRow[]>`
        INSERT INTO "analytics_consent_current"
          ("subject_key", "policy_version", "status", "granted_at", "withdrawn_at", "do_not_track", "updated_at")
        VALUES (${subjectKey}, ${policyVersion}, 'granted', now(), NULL, false, now())
        ON CONFLICT ("subject_key") DO UPDATE SET
          "policy_version" = EXCLUDED."policy_version",
          "status" = 'granted',
          "granted_at" = now(),
          "withdrawn_at" = NULL,
          "updated_at" = now()
        RETURNING "status", "policy_version", "granted_at", "withdrawn_at", "do_not_track"
      `;
      return this.toRecord(rows[0]);
    });
  }

  async renew(
    subjectId: string,
    policyVersion: string,
  ): Promise<AnalyticsConsentRecord> {
    return this.grant(subjectId, policyVersion);
  }

  async withdraw(subjectId: string): Promise<AnalyticsConsentRecord> {
    const subjectKey = this.subjectKey(subjectId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockSubjects(tx, [subjectKey]);
      const rows = await tx.$queryRaw<ConsentRow[]>`
        INSERT INTO "analytics_consent_current"
          ("subject_key", "policy_version", "status", "granted_at", "withdrawn_at", "do_not_track", "updated_at")
        VALUES (${subjectKey}, ${CURRENT_CONSENT_POLICY_VERSION}, 'withdrawn', NULL, now(), false, now())
        ON CONFLICT ("subject_key") DO UPDATE SET
          "status" = 'withdrawn',
          "withdrawn_at" = now(),
          "updated_at" = now()
        RETURNING "status", "policy_version", "granted_at", "withdrawn_at", "do_not_track"
      `;
      return this.toRecord(rows[0]);
    });
  }

  async setDoNotTrack(
    subjectId: string,
    doNotTrack: boolean,
  ): Promise<AnalyticsConsentRecord> {
    const subjectKey = this.subjectKey(subjectId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockSubjects(tx, [subjectKey]);
      const rows = await tx.$queryRaw<ConsentRow[]>`
        INSERT INTO "analytics_consent_current"
          ("subject_key", "policy_version", "status", "granted_at", "withdrawn_at", "do_not_track", "updated_at")
        VALUES (${subjectKey}, ${CURRENT_CONSENT_POLICY_VERSION}, 'none', NULL, NULL, ${doNotTrack}, now())
        ON CONFLICT ("subject_key") DO UPDATE SET
          "do_not_track" = EXCLUDED."do_not_track",
          "updated_at" = now()
        RETURNING "status", "policy_version", "granted_at", "withdrawn_at", "do_not_track"
      `;
      return this.toRecord(rows[0]);
    });
  }

  async rotateSubject(
    oldSubjectId: string,
    newSubjectId: string,
  ): Promise<void> {
    const oldSubjectKey = this.subjectKey(oldSubjectId);
    const newSubjectKey = this.subjectKey(newSubjectId);
    if (oldSubjectKey === newSubjectKey) return;

    await this.prisma.$transaction(async (tx) => {
      await this.lockSubjects(tx, [oldSubjectKey, newSubjectKey]);
      for (const subjectKey of [oldSubjectKey, newSubjectKey]) {
        await tx.$executeRaw`
          DELETE FROM "analytics_consent_current"
          WHERE "subject_key" = ${subjectKey}
        `;
        await tx.$executeRaw`
          DELETE FROM "analytics_consent_history"
          WHERE "subject_key" = ${subjectKey}
             OR "related_subject_key" = ${subjectKey}
        `;
      }
      for (const [subjectId, subjectKey] of [
        [oldSubjectId, oldSubjectKey],
        [newSubjectId, newSubjectKey],
      ]) {
        await tx.$executeRaw`
          DELETE FROM "AiUsageMetric"
          WHERE "userId" = ${subjectKey} OR "userId" = ${subjectId}
        `;
      }
      await this.insertHistory(
        tx,
        'subject_rotated',
        oldSubjectKey,
        newSubjectKey,
      );
    });
  }

  async deleteSubject(subjectId: string): Promise<void> {
    const subjectKey = this.subjectKey(subjectId);
    await this.prisma.$transaction(async (tx) => {
      await this.lockSubjects(tx, [subjectKey]);
      await tx.$executeRaw`
        DELETE FROM "analytics_consent_current"
        WHERE "subject_key" = ${subjectKey}
      `;
      await tx.$executeRaw`
        DELETE FROM "analytics_consent_history"
        WHERE "subject_key" = ${subjectKey}
           OR "related_subject_key" = ${subjectKey}
      `;
      await tx.$executeRaw`
        DELETE FROM "AiUsageMetric"
        WHERE "userId" = ${subjectKey} OR "userId" = ${subjectId}
      `;
      await this.insertHistory(tx, 'subject_deleted', null, null);
    });
  }

  async hasValidConsent(
    subjectId: string,
    requiredPolicyVersion = CURRENT_CONSENT_POLICY_VERSION,
  ): Promise<boolean> {
    if (requiredPolicyVersion !== CURRENT_CONSENT_POLICY_VERSION) return false;
    return (await this.collectIfValid(subjectId, async () => true)).allowed;
  }

  async collectIfValid<T>(
    subjectId: string,
    collect: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<ConsentCollectionResult<T>> {
    const subjectKey = this.subjectKey(subjectId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockSubjects(tx, [subjectKey]);
      const rows = await tx.$queryRaw<ConsentRow[]>`
        SELECT "status", "policy_version", "granted_at", "withdrawn_at", "do_not_track"
        FROM "analytics_consent_current"
        WHERE "subject_key" = ${subjectKey}
        LIMIT 1
      `;
      const record = this.toRecord(rows[0]);
      if (record.doNotTrack) return { allowed: false, reason: 'dnt' };
      if (record.status === 'withdrawn')
        return { allowed: false, reason: 'withdrawn' };
      if (
        record.status !== 'granted' ||
        record.policyVersion !== CURRENT_CONSENT_POLICY_VERSION
      )
        return { allowed: false, reason: 'no_consent' };
      return { allowed: true, value: await collect(tx) };
    });
  }

  getSubjectKey(subjectId: string): string {
    return this.subjectKey(subjectId);
  }

  @Cron('0 0 2 * * *', { timeZone: 'UTC' })
  async purgeExpiredHistory(): Promise<void> {
    await this.prisma.$executeRaw`
      DELETE FROM "analytics_consent_history"
      WHERE "retention_until" <= now()
    `;
  }

  private async lockSubjects(
    tx: Prisma.TransactionClient,
    subjectKeys: string[],
  ): Promise<void> {
    for (const subjectKey of [...new Set(subjectKeys)].sort()) {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${subjectKey}, 0))
      `;
    }
  }

  private async insertHistory(
    tx: Prisma.TransactionClient,
    eventType: 'subject_rotated' | 'subject_deleted',
    subjectKey: string | null,
    relatedSubjectKey: string | null,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "analytics_consent_history"
        ("id", "event_type", "subject_key", "related_subject_key", "occurred_at", "retention_until")
      VALUES (
        ${randomUUID()},
        ${eventType},
        ${subjectKey},
        ${relatedSubjectKey},
        now(),
        now() + (${HISTORY_RETENTION_DAYS} * interval '1 day')
      )
    `;
  }

  private toRecord(row: ConsentRow | undefined): AnalyticsConsentRecord {
    if (!row) {
      return {
        status: 'none',
        policyVersion: CURRENT_CONSENT_POLICY_VERSION,
        grantedAt: null,
        withdrawnAt: null,
        doNotTrack: false,
      };
    }
    if (
      !['none', 'granted', 'withdrawn'].includes(row.status) ||
      typeof row.policy_version !== 'string' ||
      typeof row.do_not_track !== 'boolean'
    ) {
      throw new Error('Stored analytics consent record is invalid');
    }
    return {
      status: row.status,
      policyVersion: row.policy_version,
      grantedAt: row.granted_at?.toISOString() ?? null,
      withdrawnAt: row.withdrawn_at?.toISOString() ?? null,
      doNotTrack: row.do_not_track,
    };
  }

  private subjectKey(subjectId: string): string {
    if (
      typeof subjectId !== 'string' ||
      subjectId.trim().length === 0 ||
      subjectId.length > 512
    ) {
      throw new BadRequestException('Invalid analytics consent subject');
    }
    const secret = this.config.get<string>('ANALYTICS_CONSENT_SUBJECT_KEY');
    if (!secret || secret.length < 32) {
      throw new ServiceUnavailableException(
        'Analytics consent storage is not configured',
      );
    }
    return createHmac('sha256', secret)
      .update('truthbounty:analytics-consent:v1\0')
      .update(subjectId)
      .digest('hex');
  }

  private assertCurrentPolicy(policyVersion: string): void {
    if (policyVersion !== CURRENT_CONSENT_POLICY_VERSION) {
      throw new BadRequestException(
        'Consent can only be granted for the current analytics policy',
      );
    }
  }
}

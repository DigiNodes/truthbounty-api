import { Injectable } from '@nestjs/common';
import {
  AnalyticsConsentRecord,
  ConsentStatus,
} from './analytics.types';
import { CURRENT_CONSENT_POLICY_VERSION } from './analytics.schemas';

/**
 * In-memory consent registry for optional analytics.
 * Operational telemetry (Prometheus) does not use this service.
 */
@Injectable()
export class AnalyticsConsentService {
  private readonly bySubject = new Map<string, AnalyticsConsentRecord>();

  get(subjectId: string): AnalyticsConsentRecord {
    const existing = this.bySubject.get(subjectId);
    if (existing) return { ...existing };
    return {
      subjectId,
      status: 'none',
      policyVersion: CURRENT_CONSENT_POLICY_VERSION,
      grantedAt: null,
      withdrawnAt: null,
      doNotTrack: false,
    };
  }

  grant(subjectId: string, policyVersion = CURRENT_CONSENT_POLICY_VERSION): AnalyticsConsentRecord {
    const now = new Date().toISOString();
    const record: AnalyticsConsentRecord = {
      subjectId,
      status: 'granted',
      policyVersion,
      grantedAt: now,
      withdrawnAt: null,
      doNotTrack: false,
    };
    this.bySubject.set(subjectId, record);
    return { ...record };
  }

  /** Renew consent under a new policy version (e.g. after policy change). */
  renew(subjectId: string, policyVersion: string): AnalyticsConsentRecord {
    return this.grant(subjectId, policyVersion);
  }

  withdraw(subjectId: string): AnalyticsConsentRecord {
    const prev = this.get(subjectId);
    const record: AnalyticsConsentRecord = {
      ...prev,
      status: 'withdrawn',
      withdrawnAt: new Date().toISOString(),
    };
    this.bySubject.set(subjectId, record);
    return { ...record };
  }

  setDoNotTrack(subjectId: string, dnt: boolean): AnalyticsConsentRecord {
    const prev = this.get(subjectId);
    const record: AnalyticsConsentRecord = { ...prev, doNotTrack: dnt };
    this.bySubject.set(subjectId, record);
    return { ...record };
  }

  /**
   * Wallet rotation: drop consent tied to the old subject id.
   * New wallet must grant consent again (fail closed).
   */
  rotateSubject(oldSubjectId: string, newSubjectId: string): void {
    this.bySubject.delete(oldSubjectId);
    // Do not copy consent to the new id.
    this.bySubject.delete(newSubjectId);
  }

  /** Deletion / right-to-erasure for consent + stops future collection. */
  deleteSubject(subjectId: string): void {
    this.bySubject.delete(subjectId);
  }

  hasValidConsent(subjectId: string, requiredPolicyVersion?: string): boolean {
    const c = this.get(subjectId);
    if (c.status !== 'granted') return false;
    if (c.doNotTrack) return false;
    if (requiredPolicyVersion && c.policyVersion !== requiredPolicyVersion) {
      return false;
    }
    return true;
  }
}

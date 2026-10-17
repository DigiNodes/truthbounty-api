import {
  computeFreshness,
  projectPublicIncidentDetail,
  projectPublicIncidentList,
  projectPublicIncidentSummary,
} from './public-incidents.projector';
import {
  RAW_DRAFT_INCIDENT,
  RAW_MONITORING_INCIDENT,
  RAW_RESOLVED_INCIDENT,
  RAW_STALE_INCIDENT,
  RAW_UNTRUSTED_AND_DRAFT_INCIDENT,
  SCENARIO_NOW,
  SCENARIO_POLICY,
} from '../../../test/fixtures/contracts/public-incidents.scenarios';

describe('Public Incidents Projector (UX-BE-002)', () => {
  describe('computeFreshness', () => {
    it('returns unknown if date is null, undefined, or invalid', () => {
      expect(computeFreshness(null, SCENARIO_NOW, 120)).toBe('unknown');
      expect(computeFreshness(undefined, SCENARIO_NOW, 120)).toBe('unknown');
      expect(computeFreshness('invalid-date', SCENARIO_NOW, 120)).toBe(
        'unknown',
      );
    });

    it('returns fresh if within stale threshold', () => {
      const recent = new Date(SCENARIO_NOW.getTime() - 60 * 1000);
      expect(computeFreshness(recent, SCENARIO_NOW, 120)).toBe('fresh');
    });

    it('returns stale if past stale threshold', () => {
      const old = new Date(SCENARIO_NOW.getTime() - 300 * 1000);
      expect(computeFreshness(old, SCENARIO_NOW, 120)).toBe('stale');
    });
  });

  describe('projectPublicIncidentSummary', () => {
    it('returns null for unapproved or draft records', () => {
      expect(projectPublicIncidentSummary(RAW_DRAFT_INCIDENT)).toBeNull();
      expect(
        projectPublicIncidentSummary({
          ...RAW_MONITORING_INCIDENT,
          isDraft: true,
        }),
      ).toBeNull();
      expect(
        projectPublicIncidentSummary({
          ...RAW_MONITORING_INCIDENT,
          isApproved: false,
        }),
      ).toBeNull();
    });

    it('projects allow-listed summary fields with immutable timestamps', () => {
      const summary = projectPublicIncidentSummary(RAW_MONITORING_INCIDENT);
      expect(summary).not.toBeNull();
      expect(summary!.id).toBe(RAW_MONITORING_INCIDENT.id);
      expect(summary!.title).toBe('API Gateway Latency Degradation');
      expect(summary!.status).toBe('monitoring');
      expect(summary!.impact).toBe('minor');
      expect(summary!.affectedComponents).toEqual(['api', 'web']);
      expect(summary!.startedAt).toBe('2026-10-16T11:15:00.000Z');
      expect(summary!.updatedAt).toBe('2026-10-16T11:50:00.000Z');
      expect(summary!.resolvedAt).toBeNull();
      expect(summary!.publicationSequence).toBe(2);
    });

    it('sets resolvedAt for resolved incidents', () => {
      const summary = projectPublicIncidentSummary(RAW_RESOLVED_INCIDENT);
      expect(summary).not.toBeNull();
      expect(summary!.status).toBe('resolved');
      expect(summary!.resolvedAt).toBe('2026-10-16T11:30:00.000Z');
    });
  });

  describe('projectPublicIncidentDetail', () => {
    it('returns null for drafts', () => {
      expect(projectPublicIncidentDetail(RAW_DRAFT_INCIDENT)).toBeNull();
    });

    it('projects detail with sanitized links and publication history', () => {
      const detail = projectPublicIncidentDetail(RAW_RESOLVED_INCIDENT);
      expect(detail).not.toBeNull();
      expect(detail!.postIncidentLinks).toHaveLength(1);
      expect(detail!.postIncidentLinks[0].title).toBe(
        'Post-Mortem Writeup: Database Failover',
      );
      expect(detail!.postIncidentLinks[0].url).toBe(
        'https://docs.truthbounty.io/reports/inc-002-failover-postmortem',
      );
      expect(detail!.publicationHistory).toHaveLength(3);
      expect(detail!.publicationHistory[0].status).toBe('investigating');
      expect(detail!.publicationHistory[2].status).toBe('resolved');
    });

    it('sanitizes malicious markdown and invalid URLs from untrusted inputs', () => {
      const detail = projectPublicIncidentDetail(
        RAW_UNTRUSTED_AND_DRAFT_INCIDENT,
      );
      expect(detail).not.toBeNull();
      expect(detail!.title).toBe('Potential XSS & Internal Leak Probe');
      expect(detail!.description).not.toContain('s3cr3t');
      expect(detail!.description).not.toContain('postgres://');
      expect(detail!.description).not.toContain('cluster.local');
      expect(detail!.mitigation).not.toContain('<iframe');

      // Invalid URLs must be omitted:
      // javascript: link and private IP link must be filtered out
      expect(detail!.postIncidentLinks).toHaveLength(1);
      expect(detail!.postIncidentLinks[0].url).toBe(
        'https://docs.truthbounty.io/security/disclosure-2026',
      );
      expect(detail!.postIncidentLinks[0].title).toBe('Safe public writeup');
    });
  });

  describe('projectPublicIncidentList', () => {
    it('projects paginated list and computes metadata', () => {
      const records = [RAW_MONITORING_INCIDENT, RAW_RESOLVED_INCIDENT];
      const result = projectPublicIncidentList(
        records,
        10,
        1,
        2,
        SCENARIO_NOW,
        SCENARIO_POLICY,
      );

      expect(result.data).toHaveLength(2);
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.limit).toBe(2);
      expect(result.pagination.total).toBe(10);
      expect(result.pagination.totalPages).toBe(5);
      expect(result.pagination.hasNext).toBe(true);
      expect(result.pagination.hasPrevious).toBe(false);
      expect(result.freshness).toBe('fresh');
    });

    it('marks freshness as stale if oldest update exceeds policy', () => {
      const result = projectPublicIncidentList(
        [RAW_STALE_INCIDENT],
        1,
        1,
        10,
        SCENARIO_NOW,
        SCENARIO_POLICY,
      );
      expect(result.freshness).toBe('stale');
    });

    it('returns empty list with fresh status for empty results', () => {
      const result = projectPublicIncidentList(
        [],
        0,
        1,
        10,
        SCENARIO_NOW,
        SCENARIO_POLICY,
      );
      expect(result.data).toHaveLength(0);
      expect(result.pagination.total).toBe(0);
      expect(result.pagination.totalPages).toBe(1);
      expect(result.freshness).toBe('fresh');
    });
  });
});

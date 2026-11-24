/**
 * UX-BE-002 Public Incident Projections scenarios.
 *
 * Scenarios covering:
 * - Monitoring
 * - Resolved
 * - Stale
 * - Unavailable
 * - Pagination
 * - Unknown ID
 * - Publication history
 * - Draft / internal field separation
 * - Untrusted Markdown and URL sanitization
 *
 * Raw inputs contain protected fields (investigationNotes, reportedBy, assignedTo,
 * internal connection strings, HTML/XSS payloads) to prove leak prevention and redaction.
 */

import { RawPublicIncidentRecord } from '../../../src/health/public-incidents/public-incidents.projector';

export const SCENARIO_NOW = new Date('2026-10-16T12:00:00.000Z');
const minutesAgo = (m: number) =>
  new Date(SCENARIO_NOW.getTime() - m * 60 * 1000);

export const SCENARIO_POLICY = { staleAfterSeconds: 120, cacheTtlSeconds: 15 };

export const FORBIDDEN_INCIDENT_SUBSTRINGS = [
  'db.internal.truthbounty',
  'postgres://',
  's3cr3t',
  'cluster.local',
  'investigationNotes',
  'reportedBy',
  'assignedTo',
  'rootCauseInternal',
  'admin_users',
  '<script>',
  'javascript:',
  'failureReason',
  'rpc.internal',
];

export const RAW_MONITORING_INCIDENT: RawPublicIncidentRecord = {
  id: 'inc-001-monitoring-uuid',
  title: 'API Gateway Latency Degradation',
  status: 'monitoring',
  impact: 'minor',
  affectedComponents: ['api', 'web'],
  description:
    'We observed elevated response times on verification endpoints. Connection pooling was adjusted and we are monitoring stability.',
  mitigation:
    'Scaled backend API workers and recycled connection pool. Service latency returned to baseline.',
  postIncidentLinks: [
    {
      title: 'Real-time telemetry dashboard',
      url: 'https://status.truthbounty.io/telemetry/api-gateway',
    },
  ],
  publicationHistory: [
    {
      id: 'pub-001-1',
      status: 'investigating',
      message: 'Investigating elevated response times on verification endpoints.',
      publishedAt: minutesAgo(45).toISOString(),
      affectedComponents: ['api'],
    },
    {
      id: 'pub-001-2',
      status: 'monitoring',
      message:
        'Mitigation applied. Traffic is nominal; ongoing monitoring in effect.',
      publishedAt: minutesAgo(10).toISOString(),
      affectedComponents: ['api', 'web'],
    },
  ],
  isApproved: true,
  isDraft: false,
  publicationSequence: 2,
  startedAt: minutesAgo(45),
  publishedAt: minutesAgo(10),
  resolvedAt: null,
};

export const RAW_RESOLVED_INCIDENT: RawPublicIncidentRecord = {
  id: 'inc-002-resolved-uuid',
  title: 'Database Replica Failover Recovery',
  status: 'resolved',
  impact: 'major',
  affectedComponents: ['database'],
  description:
    'A hardware fault caused an automated database failover to the standby replica.',
  mitigation:
    'Standby replica assumed primary leadership within 12 seconds. Re-synchronization verified and complete.',
  postIncidentLinks: [
    {
      title: 'Post-Mortem Writeup: Database Failover',
      url: 'https://docs.truthbounty.io/reports/inc-002-failover-postmortem',
    },
  ],
  publicationHistory: [
    {
      id: 'pub-002-1',
      status: 'investigating',
      message: 'Investigating database failover trigger.',
      publishedAt: minutesAgo(120).toISOString(),
      affectedComponents: ['database'],
    },
    {
      id: 'pub-002-2',
      status: 'monitoring',
      message: 'Standby promoted to primary. Sync verification in progress.',
      publishedAt: minutesAgo(60).toISOString(),
      affectedComponents: ['database'],
    },
    {
      id: 'pub-002-3',
      status: 'resolved',
      message:
        'Failover recovery complete. All integrity checks passed without data loss.',
      publishedAt: minutesAgo(30).toISOString(),
      affectedComponents: ['database'],
    },
  ],
  isApproved: true,
  isDraft: false,
  publicationSequence: 3,
  startedAt: minutesAgo(120),
  publishedAt: minutesAgo(30),
  resolvedAt: minutesAgo(30),
};

export const RAW_STALE_INCIDENT: RawPublicIncidentRecord = {
  id: 'inc-003-stale-uuid',
  title: 'Indexer Catch-up Lag',
  status: 'investigating',
  impact: 'minor',
  affectedComponents: ['indexer'],
  description: 'Indexer backlog observed following a burst of dispute events.',
  mitigation: 'Parallel batch workers spawned.',
  postIncidentLinks: [],
  publicationHistory: [
    {
      id: 'pub-003-1',
      status: 'investigating',
      message: 'Investigating indexer lag behind finalized head.',
      publishedAt: minutesAgo(180).toISOString(),
      affectedComponents: ['indexer'],
    },
  ],
  isApproved: true,
  isDraft: false,
  publicationSequence: 1,
  startedAt: minutesAgo(180),
  publishedAt: minutesAgo(180), // 3 hours ago -> stale
  resolvedAt: null,
};

export const RAW_UNTRUSTED_AND_DRAFT_INCIDENT: RawPublicIncidentRecord & {
  investigationNotes: Array<{ author: string; content: string }>;
  reportedBy: string;
  assignedTo: string;
} = {
  id: 'inc-004-untrusted-uuid',
  title: 'Potential XSS & Internal Leak Probe <script>alert("xss")</script>',
  status: 'monitoring',
  impact: 'critical',
  affectedComponents: ['evidence_gateway', 'rpc'],
  description:
    'Investigating probe on http://ipfs-node-7.cluster.local:5001 with secret s3cr3t and [exploit](javascript:stealTokens()). Connection string postgres://admin:s3cr3t@db.internal.truthbounty:5432/truthbounty.',
  mitigation:
    '<iframe src="malicious.html"></iframe> Query routing secured and credentials rotated.',
  postIncidentLinks: [
    {
      title: 'Safe public writeup <script>',
      url: 'https://docs.truthbounty.io/security/disclosure-2026',
    },
    {
      title: 'Malicious javascript link',
      url: 'javascript:alert(document.cookie)',
    },
    {
      title: 'Private IP link',
      url: 'https://192.168.1.100/admin',
    },
  ],
  publicationHistory: [
    {
      id: 'pub-004-1',
      status: 'investigating',
      message: 'Received report from admin-7 regarding probe.',
      publishedAt: minutesAgo(50).toISOString(),
      affectedComponents: ['evidence_gateway'],
    },
  ],
  isApproved: true,
  isDraft: false,
  publicationSequence: 1,
  startedAt: minutesAgo(50),
  publishedAt: minutesAgo(15),
  resolvedAt: null,
  // Protected fields:
  investigationNotes: [
    {
      author: 'admin-analyst-1',
      content: 'CONFIDENTIAL: User 0x123 submitted strange payload to RPC.',
    },
  ],
  reportedBy: 'admin-wallet-0x12345678',
  assignedTo: 'admin-analyst-1',
};

export const RAW_DRAFT_INCIDENT: RawPublicIncidentRecord = {
  id: 'inc-005-draft-uuid',
  title: 'Internal Draft - Do Not Publish',
  status: 'investigating',
  impact: 'critical',
  affectedComponents: ['web'],
  description: 'Unreviewed internal investigation note.',
  mitigation: null,
  postIncidentLinks: [],
  publicationHistory: [],
  isApproved: false,
  isDraft: true,
  publicationSequence: 0,
  startedAt: minutesAgo(10),
  publishedAt: null,
  resolvedAt: null,
};

export const PAGINATED_INCIDENT_SET: RawPublicIncidentRecord[] = [
  RAW_MONITORING_INCIDENT,
  RAW_RESOLVED_INCIDENT,
  RAW_STALE_INCIDENT,
  {
    id: 'inc-006-uuid',
    title: 'Evidence Gateway Intermittent Timeout',
    status: 'resolved',
    impact: 'minor',
    affectedComponents: ['evidence_gateway'],
    description: 'Transient IPFS gateway connection timeouts resolved after gateway pool expansion.',
    mitigation: 'Pool expanded.',
    postIncidentLinks: [],
    publicationHistory: [],
    isApproved: true,
    isDraft: false,
    publicationSequence: 1,
    startedAt: minutesAgo(300),
    publishedAt: minutesAgo(240),
    resolvedAt: minutesAgo(240),
  },
  {
    id: 'inc-007-uuid',
    title: 'RPC Provider Quorum Divergence',
    status: 'resolved',
    impact: 'major',
    affectedComponents: ['rpc'],
    description: 'Minor divergence between RPC nodes detected and quarantined.',
    mitigation: 'Quorum divergence algorithm quarantined divergent provider.',
    postIncidentLinks: [],
    publicationHistory: [],
    isApproved: true,
    isDraft: false,
    publicationSequence: 1,
    startedAt: minutesAgo(400),
    publishedAt: minutesAgo(360),
    resolvedAt: minutesAgo(360),
  },
];

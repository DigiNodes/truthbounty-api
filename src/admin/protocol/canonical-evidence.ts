import { Repository } from 'typeorm';
import { IndexedEvent } from '../../entities/indexed-event.entity';
import { isEmergencyAction } from './operational-control-state';

export interface CanonicalEvidenceInput {
  requestId: string;
  transactionHash?: string;
  ledger?: number;
  eventId?: string;
}

export interface CanonicalEvidence {
  requestId: string;
  transactionHash: string;
  ledger: number;
  eventId: string;
  eventType: string;
  blockNumber: string;
  logIndex: number;
  finalized: true;
}

const ACTION_KEYS = [
  'action',
  'emergencyAction',
  'canonicalAction',
  'protocolAction',
  'operation',
];

const REQUEST_KEYS = [
  'requestId',
  'requestID',
  'canonicalRequestId',
  'canonicalRequestID',
];

function parseNestedJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function collectValues(value: unknown, keys: string[]): unknown[] {
  const values: unknown[] = [];
  const visit = (node: unknown): void => {
    const parsed = parseNestedJson(node);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) visit(entry);
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    for (const [key, entry] of Object.entries(parsed)) {
      if (keys.includes(key)) values.push(entry);
      visit(entry);
    }
  };
  visit(value);
  return values;
}

function hasExactRequestId(event: IndexedEvent, requestId: string): boolean {
  return [event.parsedData, event.eventData].some((source) =>
    collectValues(source, REQUEST_KEYS).some((value) => value === requestId),
  );
}

function matchesAction(event: IndexedEvent, action: string): boolean {
  const values = [
    ...collectValues(event.parsedData, ACTION_KEYS),
    ...collectValues(event.eventData, ACTION_KEYS),
  ];
  const recognized = values
    .map((value) => (typeof value === 'string' ? value.toLowerCase() : ''))
    .filter((value) => isEmergencyAction(value));
  return (
    recognized.length > 0 &&
    recognized.every((value) => value === action.toLowerCase())
  );
}

function matchesEventId(event: IndexedEvent, eventId?: string): boolean {
  if (!eventId) return true;
  if (event.id === eventId) return true;
  return /^\d+$/.test(eventId) && String(event.logIndex) === eventId;
}

function toEvidence(event: IndexedEvent, requestId: string): CanonicalEvidence {
  return {
    requestId,
    transactionHash: event.transactionHash,
    ledger: event.chainId,
    eventId: event.id,
    eventType: event.eventType,
    blockNumber: String(event.blockNumber),
    logIndex: event.logIndex,
    finalized: true,
  };
}

async function findCandidates(
  repo: Repository<IndexedEvent>,
  filters: CanonicalEvidenceInput,
): Promise<IndexedEvent[]> {
  if (filters.transactionHash) {
    return repo.find({
      where: {
        transactionHash: filters.transactionHash,
        isFinalized: true,
        ...(filters.ledger !== undefined ? { chainId: filters.ledger } : {}),
      },
      take: 20,
    });
  }

  const rows = await repo.manager.query<IndexedEvent[]>(
    `SELECT "id", "eventType", "transactionHash", "chainId", "logIndex",
             "blockNumber", "isFinalized", "eventData", "parsedData"
       FROM "indexed_events"
      WHERE "isFinalized" = true
        AND (CAST("eventData" AS text) LIKE $1 OR CAST("parsedData" AS text) LIKE $2)
      ORDER BY "blockNumber" DESC
      LIMIT 20`,
    [`%${filters.requestId}%`, `%${filters.requestId}%`],
  );
  return rows ?? [];
}

export async function findFinalizedEvidence(
  repo: Repository<IndexedEvent>,
  action: string,
  filters: CanonicalEvidenceInput,
): Promise<CanonicalEvidence | null> {
  const candidates = await findCandidates(repo, filters);
  const selected = candidates.find(
    (event) =>
      event.isFinalized === true &&
      hasExactRequestId(event, filters.requestId) &&
      matchesAction(event, action) &&
      matchesEventId(event, filters.eventId),
  );
  if (!selected) return null;
  return toEvidence(selected, filters.requestId);
}

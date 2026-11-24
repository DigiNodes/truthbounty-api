import { HttpException, HttpStatus } from '@nestjs/common';

export interface StaleReconciliationPayload {
  code: 'STALE_RECONCILIATION';
  message: string;
  currentBlock: number;
  lastIndexedBlock: number;
  lag: number;
  action: 'FAIL_CLOSED';
}

/**
 * Thrown when indexer or reconciliation lag exceeds freshness threshold.
 * Guarantees fail-closed semantics across read projections.
 */
export class StaleReconciliationException extends HttpException {
  constructor(currentBlock: number, lastIndexedBlock: number, lag: number) {
    const payload: StaleReconciliationPayload = {
      code: 'STALE_RECONCILIATION',
      message: `Indexer block lag (${lag} blocks) exceeds allowed freshness threshold. Fail closed.`,
      currentBlock,
      lastIndexedBlock,
      lag,
      action: 'FAIL_CLOSED',
    };
    super(payload, HttpStatus.CONFLICT);
  }
}

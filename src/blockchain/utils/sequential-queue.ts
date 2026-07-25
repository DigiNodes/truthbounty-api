/**
 * A minimal in-process queue that runs async tasks strictly one at a time,
 * in the order they were enqueued.
 *
 * The indexer relies on this to guarantee that blocks are persisted
 * sequentially: a reorg rollback must never interleave with the processing
 * of a newer block, otherwise balances and the checkpoint can desync.
 *
 * A task rejecting does not break the chain — subsequent tasks still run, and
 * the rejection is propagated to the caller that enqueued the failing task.
 */
export class SequentialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  /**
   * Enqueue a task. Resolves/rejects with the task's own result, but only
   * after every previously-enqueued task has settled.
   */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.pending++;

    // Chain off the tail regardless of whether the previous task fulfilled or
    // rejected, so one failure cannot stall the whole queue.
    const run = this.tail.then(
      () => task(),
      () => task(),
    );

    // The tail swallows results/errors; it only exists to serialise execution.
    this.tail = run.then(
      () => {
        this.pending--;
      },
      () => {
        this.pending--;
      },
    );

    return run;
  }

  /** Number of tasks enqueued that have not yet settled. */
  get size(): number {
    return this.pending;
  }

  /** Resolves once the queue has fully drained. */
  async onIdle(): Promise<void> {
    await this.tail;
  }
}

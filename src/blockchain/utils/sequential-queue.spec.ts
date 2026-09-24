import { SequentialQueue } from './sequential-queue';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SequentialQueue', () => {
  it('runs tasks strictly in submission order even when later tasks are faster', async () => {
    const queue = new SequentialQueue();
    const order: number[] = [];

    const p1 = queue.enqueue(async () => {
      await tick(30);
      order.push(1);
    });
    const p2 = queue.enqueue(async () => {
      await tick(5);
      order.push(2);
    });
    const p3 = queue.enqueue(async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
  });

  it('never overlaps task execution', async () => {
    const queue = new SequentialQueue();
    let active = 0;
    let maxActive = 0;

    const work = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await tick(10);
      active--;
    };

    await Promise.all([
      queue.enqueue(work),
      queue.enqueue(work),
      queue.enqueue(work),
    ]);

    expect(maxActive).toBe(1);
  });

  it('propagates a task rejection to its caller without stalling the queue', async () => {
    const queue = new SequentialQueue();

    const failing = queue.enqueue(async () => {
      throw new Error('boom');
    });
    const after = queue.enqueue(async () => 'after');

    await expect(failing).rejects.toThrow('boom');
    await expect(after).resolves.toBe('after');
  });

  it('reports outstanding size and drains via onIdle', async () => {
    const queue = new SequentialQueue();

    queue.enqueue(() => tick(10));
    queue.enqueue(() => tick(10));
    expect(queue.size).toBe(2);

    await queue.onIdle();
    expect(queue.size).toBe(0);
  });
});

import { QueueService } from './queue.service';
import type { Queue, Job } from 'bullmq';

describe('QueueService', () => {
  it('should report disabled when no queue provided', () => {
    const svc = new QueueService(undefined);
    expect(svc.isEnabled()).toBe(false);
    expect(svc.status()).toEqual({ enabled: false });
  });

  it('should enqueue and return stats when queue is provided', async () => {
    type MinimalQueue = Pick<Queue, 'add' | 'getJobCounts'>;
    const calls: Array<[string, Record<string, unknown>, unknown]> = [];
    const fakeQueue: MinimalQueue = {
      add: (name: string, data, opts) => {
        calls.push([name, data as Record<string, unknown>, opts as unknown]);
        return Promise.resolve({ id: 'job-1' } as unknown as Job);
      },
      getJobCounts: () =>
        Promise.resolve({
          waiting: 0,
          active: 0,
          completed: 1,
          failed: 0,
          delayed: 0,
          paused: 0,
        }),
    };

    const svc = new QueueService(fakeQueue as unknown as Queue);
    expect(svc.isEnabled()).toBe(true);
    expect(svc.status()).toEqual({ enabled: true });

    const enq = await svc.enqueueDemo({ hello: 'world' });
    expect(enq).toEqual({ id: 'job-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('demo');
    expect(calls[0][1]).toEqual({ hello: 'world' });

    const stats = await svc.getDemoStats();
    expect(stats).toMatchObject({ completed: 1 });
  });
});

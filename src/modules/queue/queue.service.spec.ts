import { ServiceUnavailableException } from '@nestjs/common';
import { QueueService } from './queue.service';
import type { Queue, Job } from 'bullmq';

describe('QueueService', () => {
  it('should report disabled when no queue provided', () => {
    const svc = new QueueService(undefined);
    expect(svc.isEnabled()).toBe(false);
    expect(svc.status()).toEqual({ enabled: false });
  });

  /**
   * Выключенный контур отвечает отказом, а не нулями (решение арбитра 14.09.2026). Нули
   * совпадали бы байт в байт с ответом живой пустой очереди, и «подсистемы нет» стало бы
   * неотличимо от «падений не было». Возврат любых счётчиков в этой ветке роняет кейс.
   */
  it('refuses instead of reporting zeros when no queue is provided', async () => {
    const svc = new QueueService(undefined);

    await expect(svc.getDemoStats()).rejects.toThrow(ServiceUnavailableException);
    await expect(svc.getDemoStats()).rejects.toThrow('no Redis config');
  });

  it('fills a missing counter with zero rather than dropping the key', async () => {
    // BullMQ типизует `getJobCounts` словарём, и отсутствующий ключ раньше уехал бы в ответ
    // как `undefined`: форма сохраняется, а поле пропадает.
    type MinimalQueue = Pick<Queue, 'add' | 'getJobCounts'>;
    const partialQueue: MinimalQueue = {
      add: () => Promise.resolve({ id: 'job-x' } as unknown as Job),
      getJobCounts: () => Promise.resolve({ completed: 3 } as unknown as Record<string, number>),
    };

    const svc = new QueueService(partialQueue as unknown as Queue);

    await expect(svc.getDemoStats()).resolves.toEqual({
      waiting: 0,
      active: 0,
      completed: 3,
      failed: 0,
      delayed: 0,
      paused: 0,
    });
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

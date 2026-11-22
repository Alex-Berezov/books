import { Prisma } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import { worldHero, worldPairContext } from './world-write.spec-fixtures';
import { emptyWorldData } from './world-write.data';
import { WorldWriteService } from './world-write.service';

describe('WorldWriteService: the regeneration estimate of a pair (F08-8e-4 Q1-bis)', () => {
  const context = worldPairContext();

  it('a pair not linked and without shared chapters: the estimate counts the chapters of both heroes', async () => {
    const estimate = jest.fn().mockReturnValue(new Prisma.Decimal(0));
    const llm = {
      stageCallEstimator: jest.fn().mockResolvedValue({ enabled: true, maxTokens: 0, estimate }),
    };
    const service = new WorldWriteService(
      { bookDossier: { findUnique: jest.fn().mockResolvedValue({ data: {} }) } } as never,
      llm as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { contextOf: jest.fn().mockResolvedValue(context) } as never,
    );
    const data = {
      ...emptyWorldData(),
      candidates: [worldHero('anna', [1]), worldHero('boris', [2])],
      pairs: [{ key: 'anna--boris', a: 'anna', b: 'boris', linked: false, chapters: [] }],
    };
    await (service as unknown as { regenUsd: (...a: unknown[]) => Promise<unknown> }).regenUsd(
      { id: 'd1', dossierId: 'dos1' },
      data,
      { key: 'anna--boris', block: 'bonds', value: null, step: 5 },
      null,
    );
    const sent = JSON.stringify(estimate.mock.calls as unknown[]);
    expect(sent).toContain('Anna maps the road.');
    expect(sent).toContain('Boris rings the bell.');
  });
});

describe('WorldWriteService: a language without a sample (F08-9 Q2)', () => {
  it('estimate and start refuse with 409 WORLD_LANGUAGE_UNSUPPORTED before any stage estimate', async () => {
    const llm = { assertEnabled: jest.fn(), stageCallEstimator: jest.fn() };
    const service = new WorldWriteService(
      {
        bookVersion: { findUnique: jest.fn().mockResolvedValue({ language: 'de', title: 'T' }) },
      } as never,
      llm as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    for (const call of [() => service.estimate('v1'), () => service.start('v1', undefined, 'u1')]) {
      const error = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'WORLD_LANGUAGE_UNSUPPORTED',
      });
    }
    expect(llm.stageCallEstimator).not.toHaveBeenCalled();
  });
});

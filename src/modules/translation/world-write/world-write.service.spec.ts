import { Prisma } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import { worldHero, worldPairContext } from './world-write.spec-fixtures';
import { WorldGeoPass } from '../../book-world/world-geo.service';
import { emptyWorldData, worldDataJson } from './world-write.data';
import { WorldWriteService } from './world-write.service';
import { pageBook, placeInput, worldStepUsd } from './world-write.steps';

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

  // /qa круг 2 F08-12b (books-tests): оценка перегенерации пункта места - шаг места на его главах.
  it('a place item: the estimate is the place step on the chapters of the place', async () => {
    // Цена запроса - его длина: сумма зависит от входа, и сверяется целиком (L-008).
    const estimate = jest.fn(
      (request: unknown) => new Prisma.Decimal(JSON.stringify(request).length),
    );
    const est = { enabled: true, maxTokens: 0, contextLength: null, estimate };
    const llm = { stageCallEstimator: jest.fn().mockResolvedValue(est) };
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
      candidates: [worldHero('anna', [1])],
      pairs: [],
      places: [
        { key: 'bell', name: 'The bell', aliases: [], mentions: { chapters: [2], perChapter: {} } },
      ],
    };
    const usd = await (
      service as unknown as { regenUsd: (...a: unknown[]) => Promise<Prisma.Decimal> }
    ).regenUsd(
      { id: 'd1', dossierId: 'dos1' },
      data,
      { key: 'bell', block: 'significance', value: null, step: 3 },
      null,
    );
    // Ровно шаг места на его главах (автор и проверяющая), с перегенерацией блока.
    const place = data.places[0];
    const expected = worldStepUsd(
      est,
      est,
      placeInput(context as never, place, new Map(), pageBook(context as never, place, null), {
        block: 'significance',
        current: null,
        remark: null,
      }),
      0,
    );
    expect(usd.toString()).toBe(expected.toString());
    expect(estimate).toHaveBeenCalledTimes(4);
    const sent = JSON.stringify(estimate.mock.calls.slice(0, 2) as unknown[]);
    expect(sent).toContain('Boris rings the bell.');
    expect(sent).not.toContain('Anna maps the road.');
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

/**
 * Старт и оценка хода по сохранённому миру (`F08-12a`, решения `F08 | F08-12a` о составе /fix 4 и /fix 5):
 * герой анализа на ключе места не кандидат — одним правилом `runCharacters` со всеми путями хода.
 */
describe('WorldWriteService: a hero on a key taken by a place (F08-12a, review rounds 4-5)', () => {
  const setup = (
    characters: { key: string; name: string; role: string }[],
    dossier: unknown = {},
  ) => {
    const findMany = jest.fn().mockResolvedValue([{ key: 'paris', type: 'place' }]);
    const estimate = jest.fn().mockReturnValue(new Prisma.Decimal(1));
    const chapters = jest
      .fn()
      .mockResolvedValueOnce([{ number: 1, title: 'C1', content: '<p>Anna in Paris.</p>' }])
      .mockResolvedValue([]);
    const service = new WorldWriteService(
      {
        bookVersion: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ language: 'en', title: 'T', author: 'A', originalLanguage: null }),
        },
        bookAnalysis: { findUnique: jest.fn().mockResolvedValue({ characters }) },
        bookWorldEntity: { findMany },
        chapter: { findMany: chapters },
      } as never,
      {
        assertEnabled: jest.fn(),
        stageCallEstimator: jest.fn().mockResolvedValue({ enabled: true, maxTokens: 0, estimate }),
        getStageSetting: jest.fn().mockResolvedValue({ maxTokens: 0 }),
      } as never,
      {} as never,
      {} as never,
      {
        draftContext: jest.fn().mockResolvedValue({
          run: null,
          dossier: { data: dossier },
          glossaryData: null,
          dossierLine: null,
          glossaryLine: null,
        }),
      } as never,
      {} as never,
      {} as never,
    );
    return { service, findMany };
  };

  it('the only main hero sits on a place key: estimate and start refuse with 409 WORLD_ANALYSIS_MISSING', async () => {
    const { service, findMany } = setup([{ key: 'paris', name: 'Paris', role: 'main' }]);
    for (const call of [() => service.estimate('v1'), () => service.start('v1', undefined, 'u1')]) {
      const error = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'WORLD_ANALYSIS_MISSING',
      });
    }
    // Один запрос сущностей на ключах героев анализа, без отбора по типу.
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookVersionId: 'v1', key: { in: ['paris'] } },
        select: { key: true, type: true },
      }),
    );
  });

  it('the estimate counts only the heroes the run takes: the hero on the place key is left out', async () => {
    const { service, findMany } = setup([
      { key: 'anna', name: 'Anna', role: 'main' },
      { key: 'paris', name: 'Paris', role: 'main' },
    ]);
    const dto = await service.estimate('v1');
    expect(dto.candidates).toBe(1);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  // F08-12b: места досье в оценке - сверху (до порога глав), на языке с эталоном места.
  it('the estimate counts the places of the dossier as an upper bound (F08-12b)', async () => {
    const place = (key: string) => ({ key, name: key, kind: 'place', whatIs: '', firstChapter: 1 });
    const { service } = setup([{ key: 'anna', name: 'Anna', role: 'main' }], {
      entities: [place('garret'), place('square'), { ...place('axe'), kind: 'object' }],
    });
    expect((await service.estimate('v1')).places).toBe(2);
  });
});

/**
 * F08-12b, решения арбитра `F08 | F08-12b` Q3 и R2: «Accept all» - один проход проверки точки места:
 * все пункты прохода получают один и тот же `WorldGeoPass`.
 */
describe('WorldWriteService.acceptAll: one geo pass for the whole pass (F08-12b, Q3/R2)', () => {
  it('every accepted item of the pass gets the same WorldGeoPass', async () => {
    const proposed = (key: string) => ({
      key,
      block: 'short',
      step: 1,
      verdict: 'ok',
      remarks: [],
      review: null,
      outcome: 'proposed',
      value: 'Short.',
      sources: null,
      name: key,
      base: null,
      failedReason: null,
      regen: null,
      regenFailedReason: null,
    });
    const accepted = new Set<number>();
    const row = () => ({
      id: 'd1',
      kind: 'world_write',
      status: 'ready',
      data: {
        ...(worldDataJson(emptyWorldData()) as object),
        items: [proposed('square'), proposed('garret')].map((i, index) =>
          accepted.has(index) ? { ...i, outcome: 'accepted' } : i,
        ),
      },
    });
    const accept = jest.fn((_row: unknown, index: number) => {
      accepted.add(index);
      return Promise.resolve();
    });
    const service = new WorldWriteService(
      { contentDraft: { findUnique: jest.fn(() => Promise.resolve(row())) } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { accept } as never,
      {} as never,
    );
    (service as unknown as { get: jest.Mock }).get = jest.fn().mockResolvedValue({ id: 'd1' });
    await service.acceptAll('d1');
    expect(accept).toHaveBeenCalledTimes(2);
    const [first, second] = accept.mock.calls as unknown as Array<
      [unknown, number, unknown, unknown]
    >;
    expect(first[3]).toBeInstanceOf(WorldGeoPass);
    expect(second[3]).toBe(first[3]);
  });
});

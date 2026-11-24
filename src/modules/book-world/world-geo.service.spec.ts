import type { PrismaService } from '../../prisma/prisma.service';
import type { WikidataClient } from './wikidata.client';
import { geoFingerprint, WIKIDATA_EARTH } from './world-geo';
import { Prisma } from '@prisma/client';
import { WORLD_GEO_BUDGET_MS, WORLD_GEO_PARALLEL, WorldGeoService } from './world-geo.service';

/**
 * Запись точки места (`F08-12a`, решение арбитра `F08 | F08-12` Q2): после транзакции записи, под
 * замком мира, только если вход проверки не сменился за время запроса, без сдвига `updatedAt`.
 */
const UPDATED = new Date('2026-11-24T10:00:00Z');
const row = (over: Record<string, unknown> = {}) => ({
  key: 'petersburg',
  type: 'place',
  name: 'Петербург',
  aliases: null,
  blocks: { kind: 'real', wikidataId: 'Q656' },
  geo: null,
  updatedAt: UPDATED,
  ...over,
});
const body = {
  entities: {
    Q656: {
      labels: { ru: { value: 'Петербург' } },
      claims: {
        P625: [
          {
            rank: 'normal',
            mainsnak: {
              datavalue: { value: { latitude: 59.9, longitude: 30.3, globe: WIKIDATA_EARTH } },
            },
          },
        ],
      },
    },
  },
};

type UpdateCall = [{ data: { geo: unknown; updatedAt: Date } }];

function setup(rows: unknown[], current: unknown = rows[0]) {
  const update = jest.fn().mockResolvedValue({});
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    bookVersion: { findUnique: jest.fn().mockResolvedValue({ status: 'published' }) },
    bookWorldEntity: { findUnique: jest.fn().mockResolvedValue(current), update },
  };
  const db = {
    bookWorldEntity: { findMany: jest.fn().mockResolvedValue(rows) },
    $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };
  const entity = jest.fn().mockResolvedValue({ kind: 'ok', body });
  const service = new WorldGeoService(
    db as unknown as PrismaService,
    { entity } as unknown as WikidataClient,
  );
  const written = () => (update.mock.calls[0] as UpdateCall)[0].data;
  return { service, update, entity, db, written, tx };
}

describe('WorldGeoService.refresh (F08-12a, Q2)', () => {
  it('реальное место с номером — запрос к Wikidata и точка без сдвига updatedAt', async () => {
    const { service, entity, written, db, update, tx } = setup([row()]);
    await expect(service.refresh('v-1', 'ru', ['petersburg', 'petersburg'])).resolves.toBe(1);
    expect(entity).toHaveBeenCalledTimes(1);
    expect(entity).toHaveBeenCalledWith('Q656');
    expect(update).toHaveBeenCalledTimes(1);
    // Строки только этой версии и только ключи записи; запись — в транзакции под замком мира.
    expect(db.bookWorldEntity.findMany).toHaveBeenCalledTimes(1);
    expect(db.bookWorldEntity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { bookVersionId: 'v-1', key: { in: ['petersburg'] } } }),
    );
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // Под замком перечитывается и пишется ровно эта строка этой версии.
    const target = { bookVersionId_key: { bookVersionId: 'v-1', key: 'petersburg' } };
    expect(tx.bookWorldEntity.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: target }),
    );
    expect(tx.bookWorldEntity.findUnique).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: target }));
    expect(written().geo).toMatchObject({ language: 'ru' });
    expect(written().updatedAt).toBe(UPDATED);
    expect(written().geo).toMatchObject({
      wikidataId: 'Q656',
      point: { lat: 59.9, lng: 30.3 },
      reason: null,
    });
  });

  it('вход сменился за время запроса — итог не пишется', async () => {
    const { service, update } = setup([row()], row({ blocks: { kind: 'real', wikidataId: 'Q1' } }));
    await expect(service.refresh('v-1', 'ru', ['petersburg'])).resolves.toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it('тот же вход уже проверен — запроса нет', async () => {
    const checkedFor = geoFingerprint({ wikidataId: 'Q656', language: 'ru', names: ['Петербург'] });
    const geo = {
      wikidataId: 'Q656',
      checkedFor,
      language: 'ru',
      checkedAt: 't',
      point: { lat: 1, lng: 2 },
      reason: null,
    };
    const { service, entity, update } = setup([row({ geo })]);
    await expect(service.refresh('v-1', 'ru', ['petersburg'])).resolves.toBe(0);
    expect(entity).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('место стало вымышленным — прежняя проверка снимается без запроса', async () => {
    const geo = {
      wikidataId: 'Q656',
      checkedFor: 'f',
      language: 'ru',
      checkedAt: 't',
      point: { lat: 1, lng: 2 },
      reason: null,
    };
    const { service, entity, written } = setup([row({ geo, blocks: { kind: 'fictional' } })]);
    await expect(service.refresh('v-1', 'ru', ['petersburg'])).resolves.toBe(1);
    expect(entity).not.toHaveBeenCalled();
    expect(written().geo).toBe(Prisma.DbNull);
  });

  it('Wikidata не ответила — проверки не было: прежний итог не перезаписывается (ревью круга 2)', async () => {
    const geo = {
      wikidataId: 'Q656',
      checkedFor: 'old',
      language: 'ru',
      checkedAt: 't',
      point: { lat: 1, lng: 2 },
      reason: null,
    };
    const { service, entity, update } = setup([row({ geo })]);
    entity.mockResolvedValue({ kind: 'unavailable' });
    await expect(service.refresh('v-1', 'ru', ['petersburg'])).resolves.toBe(0);
    expect(entity).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('строка перестала быть местом — прежняя проверка снимается', async () => {
    const geo = {
      wikidataId: 'Q656',
      checkedFor: 'f',
      language: 'ru',
      checkedAt: 't',
      point: { lat: 1, lng: 2 },
      reason: null,
    };
    const hero = row({ type: 'character', geo, blocks: {} });
    const { service, entity, written } = setup([hero]);
    await expect(service.refresh('v-1', 'ru', ['petersburg'])).resolves.toBe(1);
    expect(entity).not.toHaveBeenCalled();
    expect(written().geo).toBe(Prisma.DbNull);
  });

  it('name_mismatch при том же отпечатке не проверяется заново (решение R1)', async () => {
    const checkedFor = geoFingerprint({ wikidataId: 'Q656', language: 'ru', names: ['Петербург'] });
    const geo = {
      wikidataId: 'Q656',
      checkedFor,
      language: 'ru',
      checkedAt: 't',
      point: null,
      reason: 'name_mismatch',
    };
    const { service, entity } = setup([row({ geo })]);
    await expect(service.refresh('v-1', 'ru', ['petersburg'])).resolves.toBe(0);
    expect(entity).not.toHaveBeenCalled();
  });

  it('порции по WORLD_GEO_PARALLEL; Wikidata не ответила в порции — новых запросов нет', async () => {
    const rows = Array.from({ length: WORLD_GEO_PARALLEL * 3 }, (_, i) => row({ key: `p${i}` }));
    const { service, entity, tx } = setup(rows);
    tx.bookWorldEntity.findUnique.mockImplementation(
      ({ where }: { where: { bookVersionId_key: { key: string } } }) =>
        Promise.resolve(row({ key: where.bookVersionId_key.key })),
    );
    entity.mockResolvedValue({ kind: 'unavailable' });
    await service.refresh(
      'v-1',
      'ru',
      rows.map((r) => r.key),
    );
    expect(entity).toHaveBeenCalledTimes(WORLD_GEO_PARALLEL);
  });

  it('отказ записи под замком — не наружу: refresh не бросает', async () => {
    const { service, db } = setup([row()]);
    db.$transaction.mockRejectedValue(new Error('P2028'));
    await expect(service.refresh('v-1', 'ru', ['petersburg'])).resolves.toBe(0);
  });

  it('отказ чтения строк — не наружу: refresh не бросает', async () => {
    const { service, db } = setup([row()]);
    db.bookWorldEntity.findMany.mockRejectedValue(new Error('connection lost'));
    await expect(service.refresh('v-1', 'ru', ['petersburg'])).resolves.toBe(0);
  });

  it('общий срок записи: после него новые порции не начинаются (ревью круга 3)', async () => {
    const rows = Array.from({ length: WORLD_GEO_PARALLEL * 3 }, (_, i) => row({ key: `p${i}` }));
    const { service, entity, tx } = setup(rows);
    tx.bookWorldEntity.findUnique.mockImplementation(
      ({ where }: { where: { bookVersionId_key: { key: string } } }) =>
        Promise.resolve(row({ key: where.bookVersionId_key.key })),
    );
    let clock = 0;
    service.now = () => clock;
    entity.mockImplementation(() => {
      clock += WORLD_GEO_BUDGET_MS;
      return Promise.resolve({ kind: 'ok', body });
    });
    await service.refresh(
      'v-1',
      'ru',
      rows.map((r) => r.key),
    );
    expect(entity).toHaveBeenCalledTimes(WORLD_GEO_PARALLEL);
  });

  it('снятие прежней проверки идёт и после отказа Wikidata в порции (ревью круга 3)', async () => {
    const geo = {
      wikidataId: 'Q656',
      checkedFor: 'f',
      language: 'ru',
      checkedAt: 't',
      point: { lat: 1, lng: 2 },
      reason: null,
    };
    const fictional = row({ key: 'zz-fictional', geo, blocks: { kind: 'fictional' } });
    const { service, entity, update, tx } = setup([row(), fictional]);
    tx.bookWorldEntity.findUnique.mockImplementation(
      ({ where }: { where: { bookVersionId_key: { key: string } } }) =>
        Promise.resolve(where.bookVersionId_key.key === 'zz-fictional' ? fictional : row()),
    );
    const order: string[] = [];
    entity.mockImplementation(() => {
      order.push('fetch');
      return Promise.resolve({ kind: 'unavailable' });
    });
    update.mockImplementation(() => {
      order.push('clear');
      return Promise.resolve({});
    });
    await expect(service.refresh('v-1', 'ru', ['petersburg', 'zz-fictional'])).resolves.toBe(1);
    // Снятие — до запросов к Wikidata и вне срока.
    expect(order).toEqual(['clear', 'fetch']);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookVersionId_key: { bookVersionId: 'v-1', key: 'zz-fictional' } },
      }),
    );
  });

  it('без ключей — без запросов', async () => {
    const { service, db } = setup([]);
    await expect(service.refresh('v-1', 'ru', [])).resolves.toBe(0);
    expect(db.bookWorldEntity.findMany).not.toHaveBeenCalled();
  });
});

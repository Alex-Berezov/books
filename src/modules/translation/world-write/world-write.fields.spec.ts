import { WorldGeoPass } from '../../book-world/world-geo.service';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ContentDraft } from '@prisma/client';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { BookWorldService } from '../../book-world/book-world.service';
import { recordChanged } from '../../../shared/dto/expected-row.util';
import {
  emptyWorldData,
  readWorldData,
  valuePrint,
  WorldItem,
  WorldWriteData,
  worldDataJson,
} from './world-write.data';
import {
  worldReadyGate,
  worldRunGate,
  WorldWriteFields,
  withWorldSources,
} from './world-write.fields';

/**
 * Запись хода мира (`F08-4a`, `tech.md` §5): сущности нет - создаётся; блок неопубликованной сущности
 * пуст - пишется; иначе - предложение; повтор после обрыва - `written`; сверка `updatedAt`
 * с повтором; отказ импорта - пункт не записан. «Accept» сверяет блок.
 */

const item = (
  block: WorldItem['block'],
  value: unknown,
  patch: Partial<WorldItem> = {},
): WorldItem => ({
  key: 'anna',
  block,
  step: 1,
  verdict: 'ok',
  remarks: [],
  review: null,
  outcome: 'waiting',
  value,
  sources: null,
  name: 'Anna',
  base: null,
  failedReason: null,
  regen: null,
  regenFailedReason: null,
  ...patch,
});

function setup(
  items: WorldItem[],
  entity: Record<string, unknown> | null,
  initial = 'building',
  role: 'main' | 'secondary' | null = 'main',
  pairs: WorldWriteData['pairs'] = [],
  places: WorldWriteData['places'] = [],
) {
  // Кандидат хода с ролью из анализа на шаге выбора (`F08-8b`); `null` - ключа нет среди кандидатов.
  const candidates = role
    ? [{ key: 'anna', role, name: 'Anna', aliases: [], mentions: { chapters: [], perChapter: {} } }]
    : [];
  let data: WorldWriteData = { ...emptyWorldData(), candidates, pairs, places, items };
  let status = initial;
  const row = (): ContentDraft =>
    ({
      id: 'd1',
      bookVersionId: 'v1',
      kind: 'world_write',
      status,
      language: 'en',
      operationId: 'op1',
      data: worldDataJson(data),
    }) as unknown as ContentDraft;
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    contentDraft: {
      findUnique: jest.fn(() => Promise.resolve(row())),
      update: jest.fn(({ data: patch }: { data: { data: unknown } }) => {
        data = readWorldData(patch.data);
        return Promise.resolve(row());
      }),
    },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    bookWorldEntity: {
      findUnique: jest.fn().mockResolvedValue(
        entity
          ? {
              key: 'anna',
              type: 'character',
              name: 'Anna',
              role: 'main',
              short: null,
              aliases: null,
              blocks: null,
              sources: null,
              mentions: null,
              createdAt: new Date(),
              firstPublishedAt: null,
              updatedAt: new Date('2026-11-17T10:00:00.000Z'),
              ...entity,
            }
          : null,
      ),
    },
  };
  // Импорт мира зовёт `within` в своей транзакции: здесь - с той же подменой строки хода.
  const world = {
    saveEntity: jest.fn(
      async (
        ..._args: [
          string,
          string,
          unknown,
          boolean,
          unknown,
          ((t: typeof tx) => Promise<void>)?,
          WorldGeoPass?,
        ]
      ) => {
        const within = _args[5];
        if (within) await within(tx);
        return {};
      },
    ),
  };
  const fields = new WorldWriteFields(
    prisma as unknown as PrismaService,
    world as unknown as BookWorldService,
  );
  const setStatus = (next: string) => {
    status = next;
  };
  return { fields, world, prisma, tx, row, data: () => data, setStatus };
}

describe('WorldWriteFields.settleStep', () => {
  // F08-12b, решения арбитра `F08 | F08-12b` R3 и R2: вид и номер места - один пункт `kind`, в тело -
  // двумя полями; все сущности одного шага делят один проход проверки точки (`WorldGeoPass`).
  const place = (key: string) => ({
    key,
    name: key.toUpperCase(),
    aliases: [],
    mentions: { chapters: [1, 2], perChapter: {} },
  });
  it('a place kind item writes kind and wikidataId as two fields; no role; one geo pass for all entities of the step', async () => {
    const own = (key: string) => ({ key, name: key.toUpperCase() });
    const { fields, world, row } = setup(
      [
        item('kind', { kind: 'real', wikidataId: 'Q656' }, own('square')),
        item('kind', { kind: 'fictional', wikidataId: null }, own('garret')),
      ],
      null,
      'building',
      'main',
      [],
      [place('square'), place('garret')],
    );
    await expect(fields.settleStep(row(), worldRunGate('op1'), 1)).resolves.toBe('settled');
    expect(world.saveEntity).toHaveBeenCalledTimes(2);
    const [first, second] = world.saveEntity.mock.calls;
    expect(first[2]).toEqual({
      language: 'en',
      type: 'place',
      name: 'SQUARE',
      kind: 'real',
      wikidataId: 'Q656',
    });
    expect(second[2]).toMatchObject({ type: 'place', kind: 'fictional', wikidataId: null });
    const passOf = (call: (typeof world.saveEntity.mock.calls)[number]) => call[6];
    expect(passOf(first)).toBeInstanceOf(WorldGeoPass);
    expect(passOf(second)).toBe(passOf(first));
  });

  // F08-11d-2, решение `F08 | F08-11d-2` (отпечаток ТЗ): отпечаток «Внешности» едет в запись вместе с ТЗ.
  it('the brief item carries the print of its appearance into the write; without the brief - no print', async () => {
    const { fields, world, row } = setup(
      [{ ...item('imageBrief', 'Square 1:1 portrait.'), basis: 'abc123' }, item('short', 'Short.')],
      null,
    );
    await expect(fields.settleStep(row(), worldRunGate('op1'), 1)).resolves.toBe('settled');
    const body = world.saveEntity.mock.calls[0][2] as Record<string, unknown>;
    expect(body).toMatchObject({ imageBrief: 'Square 1:1 portrait.', imageBriefFor: 'abc123' });
    const plain = setup([item('short', 'Short.')], null);
    await plain.fields.settleStep(plain.row(), worldRunGate('op1'), 1);
    expect(plain.world.saveEntity.mock.calls[0][2]).not.toHaveProperty('imageBriefFor');
  });

  it('the same brief text for another appearance is not «already written»: it is proposed to renew the print; the same print - written', async () => {
    const brief = (basis: string) => ({ ...item('imageBrief', 'Square 1:1 portrait.'), basis });
    const stored = { blocks: { imageBrief: 'Square 1:1 portrait.', imageBriefFor: 'old-print' } };
    const renewed = setup([brief('new-print')], stored);
    await renewed.fields.settleStep(renewed.row(), worldRunGate('op1'), 1);
    // Блок не пуст — предложение; «Accept» запишет ТЗ с новым отпечатком.
    expect(renewed.data().items.map((i) => i.outcome)).toEqual(['proposed']);
    const same = setup([brief('old-print')], stored);
    await same.fields.settleStep(same.row(), worldRunGate('op1'), 1);
    expect(same.world.saveEntity).not.toHaveBeenCalled();
    expect(same.data().items.map((i) => i.outcome)).toEqual(['written']);
  });

  it('no entity: it is created by all items of the step, with the name and the role main, expectedAbsent', async () => {
    const { fields, world, row, data } = setup(
      [item('short', 'Short.'), item('character', 'Text.')],
      null,
    );
    await expect(fields.settleStep(row(), worldRunGate('op1'), 1)).resolves.toBe('settled');
    expect(world.saveEntity).toHaveBeenCalledTimes(1);
    expect(world.saveEntity).toHaveBeenCalledWith(
      'v1',
      'anna',
      expect.objectContaining({ name: 'Anna', role: 'main', short: 'Short.', character: 'Text.' }),
      false,
      { expectedAbsent: 'true' },
      expect.any(Function),
      expect.any(WorldGeoPass),
    );
    expect(data().items.map((i) => i.outcome)).toEqual(['written', 'written']);
  });

  it('no entity and a pair of the run: a pair is created - type pair, no role, no name forms (F08-8e)', async () => {
    const pair = { key: 'anna--boris', a: 'anna', b: 'boris', linked: true, chapters: [1] };
    const own = { key: 'anna--boris', name: 'Anna and Boris' };
    const { fields, world, row } = setup(
      [item('short', 'Two.', own), item('conclusion', 'So.', own)],
      null,
      'building',
      'main',
      [pair],
    );
    await fields.settleStep(row(), worldRunGate('op1'), 1);
    expect(world.saveEntity).toHaveBeenCalledTimes(1);
    const [, key, body, , expected] = world.saveEntity.mock.calls[0];
    expect(key).toBe('anna--boris');
    expect(body).toEqual({
      language: 'en',
      type: 'pair',
      name: 'Anna and Boris',
      short: 'Two.',
      conclusion: 'So.',
    });
    expect(expected).toEqual({ expectedAbsent: 'true' });
  });

  it('no entity and a secondary candidate: the entity is created with the role of the candidate (F08-8b)', async () => {
    const { fields, world, row } = setup([item('short', 'Short.')], null, 'building', 'secondary');
    await fields.settleStep(row(), worldRunGate('op1'), 1);
    expect(world.saveEntity).toHaveBeenCalledTimes(1);
    expect(world.saveEntity).toHaveBeenCalledWith(
      'v1',
      'anna',
      expect.objectContaining({ role: 'secondary' }),
      false,
      { expectedAbsent: 'true' },
      expect.any(Function),
      expect.any(WorldGeoPass),
    );
  });

  it('an unpublished entity: an empty block is written, a filled one becomes a proposal with the print of the block', async () => {
    const { fields, world, row, data } = setup(
      [item('short', 'Short.'), item('character', 'Text.')],
      { short: 'Editor text.' },
    );
    await fields.settleStep(row(), worldRunGate('op1'), 1);
    const body = world.saveEntity.mock.calls[0][2] as Record<string, unknown>;
    expect(body).toMatchObject({ character: 'Text.' });
    expect(body).not.toHaveProperty('short');
    expect(body).not.toHaveProperty('name');
    expect(world.saveEntity.mock.calls[0][4]).toEqual({
      expectedUpdatedAt: '2026-11-17T10:00:00.000Z',
    });
    expect(data().items.map((i) => [i.block, i.outcome, i.base])).toEqual([
      ['short', 'proposed', valuePrint('Editor text.')],
      ['character', 'written', null],
    ]);
  });

  it('a published entity: even an empty block becomes a proposal', async () => {
    const { fields, world, row, data } = setup([item('character', 'Text.')], {
      firstPublishedAt: new Date(),
    });
    await fields.settleStep(row(), worldRunGate('op1'), 1);
    expect(world.saveEntity).not.toHaveBeenCalled();
    expect(data().items[0].outcome).toBe('proposed');
  });

  it('the value is already in the block (a break between the write and the run data) - written without a second write', async () => {
    const { fields, world, row, data } = setup([item('short', 'Short.')], { short: 'Short.' });
    await fields.settleStep(row(), worldRunGate('op1'), 1);
    expect(world.saveEntity).not.toHaveBeenCalled();
    expect(data().items[0].outcome).toBe('written');
  });

  it('the entity changed between the read and the write (RECORD_CHANGED) - read again and repeat', async () => {
    const { fields, world, row, data } = setup([item('character', 'Text.')], {});
    world.saveEntity.mockRejectedValueOnce(recordChanged('changed'));
    await fields.settleStep(row(), worldRunGate('op1'), 1);
    expect(world.saveEntity).toHaveBeenCalledTimes(2);
    expect(data().items[0].outcome).toBe('written');
  });

  it('the world import refuses - the items are not written (WORLD_WRITE_REFUSED), the run goes on', async () => {
    const { fields, world, row, data } = setup([item('character', 'Text.')], {});
    world.saveEntity.mockRejectedValueOnce(new BadRequestException(['relations.0.to: unknown']));
    await expect(fields.settleStep(row(), worldRunGate('op1'), 1)).resolves.toBe('settled');
    expect(data().items[0]).toMatchObject({ outcome: 'none', failedReason: 'WORLD_WRITE_REFUSED' });
  });

  it('the key was taken by a place during the run (F08-12a, review round 5) - not written over it, the items refused', async () => {
    const { fields, world, row, data } = setup([item('character', 'Text.')], { type: 'place' });
    await expect(fields.settleStep(row(), worldRunGate('op1'), 1)).resolves.toBe('settled');
    expect(world.saveEntity).toHaveBeenCalledTimes(0);
    expect(data().items[0]).toMatchObject({ outcome: 'none', failedReason: 'WORLD_WRITE_REFUSED' });
  });

  it('a run of another operation - gone, nothing is written', async () => {
    const { fields, world, row } = setup([item('character', 'Text.')], {});
    await expect(fields.settleStep(row(), worldRunGate('op2'), 1)).resolves.toBe('gone');
    expect(world.saveEntity).not.toHaveBeenCalled();
  });
});

describe('WorldWriteFields.accept', () => {
  it('the key is a place now (F08-12a, review round 5) - 409 WORLD_WRITE_REFUSED, nothing written', async () => {
    const proposed = item('short', 'Short.', { outcome: 'proposed', base: valuePrint(null) });
    const { fields, world, row } = setup([proposed], { type: 'place' }, 'ready');
    const error = await fields.accept(row(), 0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'WORLD_WRITE_REFUSED',
    });
    expect(world.saveEntity).toHaveBeenCalledTimes(0);
  });

  it('the block changed after the proposal - 409 WORLD_BLOCK_CHANGED with the current block, nothing written', async () => {
    const proposed = item('short', 'Short.', {
      outcome: 'proposed',
      base: valuePrint('Editor text.'),
    });
    const { fields, world, row } = setup([proposed], { short: 'Second edit.' }, 'ready');
    const error = await fields.accept(row(), 0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'WORLD_BLOCK_CHANGED',
      current: 'Second edit.',
    });
    expect(world.saveEntity).not.toHaveBeenCalled();
  });

  it('the block is as at the proposal - written, the item accepted; another print - WORLD_PROPOSAL_CHANGED', async () => {
    const proposed = item('short', 'Short.', {
      outcome: 'proposed',
      base: valuePrint('Editor text.'),
    });
    const { fields, world, row, data } = setup([proposed], { short: 'Editor text.' }, 'ready');
    await expect(fields.accept(row(), 0, 'other')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WORLD_PROPOSAL_CHANGED' }),
    });
    await fields.accept(row(), 0);
    expect(world.saveEntity).toHaveBeenCalledTimes(1);
    expect(world.saveEntity).toHaveBeenCalledWith(
      'v1',
      'anna',
      expect.objectContaining({ short: 'Short.' }),
      false,
      { expectedUpdatedAt: '2026-11-17T10:00:00.000Z' },
      expect.any(Function),
      expect.any(WorldGeoPass),
    );
    expect(data().items[0].outcome).toBe('accepted');
  });

  it('an external block brings its checked sources into the sources of the entity, by address', async () => {
    const source = { title: 'About', url: 'https://www.about.test/a/' };
    const proposed = item('critique', 'Critics.', {
      outcome: 'proposed',
      base: valuePrint(null),
      sources: [source],
    });
    const { fields, world, row } = setup(
      [proposed],
      { sources: [{ title: 'Old', url: 'https://about.test/a' }], firstPublishedAt: new Date() },
      'ready',
    );
    await fields.accept(row(), 0);
    // Тот же адрес без `www.` и косой черты - уже в списке: второй раз не добавляется.
    expect(world.saveEntity.mock.calls[0][2]).not.toHaveProperty('sources');
    expect(withWorldSources([{ title: 'Old', url: 'https://x.test/1' }], [source])).toEqual([
      { title: 'Old', url: 'https://x.test/1' },
      source,
    ]);
  });

  it('not ready or not a proposal - 409', async () => {
    const { fields, row } = setup([item('short', 'Short.', { outcome: 'written' })], null, 'ready');
    await expect(fields.accept(row(), 0)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WORLD_ITEM_NOT_PROPOSED' }),
    });
    const building = setup([item('short', 'Short.', { outcome: 'proposed' })], null, 'building');
    await expect(building.fields.accept(building.row(), 0)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WORLD_WRITE_NOT_READY' }),
    });
    expect(worldReadyGate.kind).toBe('ready');
  });
});

/** Круг /fix 1 (/qa 17.11.2026): запись и итог хода - одной транзакцией, проверки под замком строки. */
describe('WorldWriteFields: one transaction for the entity and the run', () => {
  it('the run is discarded while the entity is written - within refuses (the write rolls back), gone, the items untouched', async () => {
    const { fields, world, row, data, setStatus, tx } = setup([item('character', 'Text.')], {});
    world.saveEntity.mockImplementationOnce(async (...args) => {
      setStatus('discarded');
      await args[5]?.(tx);
      return {};
    });
    await expect(fields.settleStep(row(), worldRunGate('op1'), 1)).resolves.toBe('gone');
    expect(data().items[0].outcome).toBe('waiting');
  });

  it('RECORD_CHANGED on every attempt - the task fails and is repeated, the items stay waiting (not refused)', async () => {
    const { fields, world, row, data } = setup([item('character', 'Text.')], {});
    world.saveEntity.mockRejectedValue(recordChanged('changed'));
    await expect(fields.settleStep(row(), worldRunGate('op1'), 1)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(world.saveEntity).toHaveBeenCalledTimes(3);
    expect(data().items[0].outcome).toBe('waiting');
  });

  it('a new entity whose key is not a candidate of the run is not created, not made main: the items are refused (F08-8b)', async () => {
    const { fields, world, row, data } = setup([item('short', 'Short.')], null, 'building', null);
    await fields.settleStep(row(), worldRunGate('op1'), 1);
    expect(world.saveEntity).not.toHaveBeenCalled();
    expect(data().items[0]).toMatchObject({ outcome: 'none', failedReason: 'WORLD_WRITE_REFUSED' });
  });

  it('a new entity without a name is not created: the items are refused', async () => {
    const { fields, world, row, data } = setup(
      [item('critique', 'Critics.', { name: null })],
      null,
    );
    await fields.settleStep(row(), worldRunGate('op1'), 1);
    expect(world.saveEntity).not.toHaveBeenCalled();
    expect(data().items[0]).toMatchObject({ outcome: 'none', failedReason: 'WORLD_WRITE_REFUSED' });
  });

  it('«Accept» of an item a regeneration started on in between - 409 WORLD_REGEN_IN_PROGRESS under the lock, the entity write rolled back', async () => {
    const proposed = item('short', 'Short.', { outcome: 'proposed', base: valuePrint(null) });
    const ctx = setup([proposed], {}, 'ready');
    const regen = { operationId: 'op9', remark: null, pending: null, previous: null };
    ctx.world.saveEntity.mockImplementationOnce(async (...args) => {
      // Перегенерация встала на пункт между чтением и записью.
      await ctx.fields.mutate(ctx.row(), worldReadyGate, (d) => ({
        ...d,
        items: d.items.map((it) => ({ ...it, regen })),
      }));
      await args[5]?.(ctx.tx);
      return {};
    });
    await expect(ctx.fields.accept(ctx.row(), 0)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WORLD_REGEN_IN_PROGRESS' }),
    });
    expect(ctx.data().items[0].outcome).toBe('proposed');
  });

  it('«Accept» after a break between the entity write and the answer - the block equals the proposal: only the mark', async () => {
    const proposed = item('short', 'Short.', {
      outcome: 'proposed',
      base: valuePrint('Editor text.'),
    });
    const { fields, world, row, data } = setup([proposed], { short: 'Short.' }, 'ready');
    await fields.accept(row(), 0);
    expect(world.saveEntity).not.toHaveBeenCalled();
    expect(data().items[0].outcome).toBe('accepted');
  });

  it('«Discard» of an item being regenerated - 409 WORLD_REGEN_IN_PROGRESS: the result would bring it back', async () => {
    const regen = { operationId: 'op9', remark: null, pending: null, previous: null };
    const { fields, row, data } = setup(
      [item('short', 'Short.', { outcome: 'proposed', regen })],
      null,
      'ready',
    );
    await expect(fields.discardItem(row(), 0)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WORLD_REGEN_IN_PROGRESS' }),
    });
    expect(data().items[0].outcome).toBe('proposed');
  });
});

/** /qa круг 2 (code-review): источники в «уже записано», отказ импорта на перегенерации. */
describe('WorldWriteFields: sources and a refused regeneration', () => {
  it('«Accept» of an external block whose text is already in the entity but whose sources are not - writes, the sources join the list', async () => {
    const source = { title: 'About', url: 'https://about.test/a' };
    const proposed = item('critique', 'Critics.', {
      outcome: 'proposed',
      base: valuePrint('Critics.'),
      sources: [source],
    });
    const { fields, world, row, data } = setup(
      [proposed],
      { blocks: { critique: 'Critics.' }, sources: [{ title: 'Old', url: 'https://old.test/b' }] },
      'ready',
    );
    await fields.accept(row(), 0);
    expect(world.saveEntity).toHaveBeenCalledTimes(1);
    expect(world.saveEntity.mock.calls[0][2]).toMatchObject({
      sources: [{ title: 'Old', url: 'https://old.test/b' }, source],
    });
    expect(data().items[0].outcome).toBe('accepted');
  });

  it('the import refuses the write of a regenerated item - refused, the item stays waiting (its previous state comes back when the mark is cleared)', async () => {
    const { fields, world, row, data } = setup([item('character', 'Text.')], {}, 'ready');
    const regen = { operationId: 'op9', remark: null, pending: null, previous: null };
    await fields.mutate(row(), worldReadyGate, (d) => ({
      ...d,
      items: d.items.map((it) => ({ ...it, regen })),
    }));
    world.saveEntity.mockRejectedValueOnce(new BadRequestException(['relations.0.to: unknown']));
    const gate = { kind: 'regen' as const, operationId: 'op9', index: 0 };
    await expect(fields.settleStep(row(), gate, 1, 0)).resolves.toBe('refused');
    expect(data().items[0].outcome).toBe('waiting');
  });
});

/** /fix 3: список источников сущности полон - внешний блок без своих источников не пишется. */
describe('WorldWriteFields: the sources list is full', () => {
  const full = Array.from({ length: 15 }, (_, i) => ({
    title: `S${i}`,
    url: `https://s${i}.test/a`,
  }));
  const source = { title: 'About', url: 'https://about.test/a' };

  it('settle: the item is refused (WORLD_WRITE_REFUSED), nothing written', async () => {
    const { fields, world, row, data } = setup(
      [item('critique', 'Critics.', { sources: [source] })],
      { sources: full },
    );
    await fields.settleStep(row(), worldRunGate('op1'), 1);
    expect(world.saveEntity).not.toHaveBeenCalled();
    expect(data().items[0]).toMatchObject({ outcome: 'none', failedReason: 'WORLD_WRITE_REFUSED' });
  });

  it('a source already in the full list (the same address) fits: the block is written', async () => {
    const known = { title: 'S0 again', url: 'https://www.s0.test/a/' };
    const { fields, world, row, data } = setup(
      [item('critique', 'Critics.', { sources: [known] })],
      { sources: full },
    );
    await fields.settleStep(row(), worldRunGate('op1'), 1);
    expect(world.saveEntity).toHaveBeenCalledTimes(1);
    expect(data().items[0].outcome).toBe('written');
  });

  it('accept: 409 WORLD_WRITE_REFUSED, the item stays a proposal', async () => {
    const proposed = item('critique', 'Critics.', {
      outcome: 'proposed',
      base: valuePrint(null),
      sources: [source],
    });
    const { fields, world, row, data } = setup([proposed], { sources: full }, 'ready');
    await expect(fields.accept(row(), 0)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WORLD_WRITE_REFUSED' }),
    });
    expect(world.saveEntity).not.toHaveBeenCalled();
    expect(data().items[0].outcome).toBe('proposed');
  });
});

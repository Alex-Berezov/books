import { BOOK_WORLD_LIMITS } from './dto/book-world-blocks.dto';
import {
  computeWorldListed,
  isWorldEntityPublic,
  WORLD_ENTITY_PUBLIC_SQL,
  WORLD_ENTITY_PUBLIC_WHERE,
  WORLD_MIN_CHAPTERS,
  WORLD_PAIRS,
  heroesFirst,
  pairMembersIn,
  relistWorldPairs,
  worldListedWrite,
  worldMembersReader,
  type WorldListedInput,
} from './world-public';

/**
 * F08-1: публичность сущности на границах (решения арбитра `F08 | F08-1` R1, R2, PM-3):
 * одна функция условия, одно условие выборки, `firstPublishedAt` не сбрасывается.
 */
const at = (iso: string) => new Date(iso);
const main = (over: Partial<WorldListedInput> = {}): WorldListedInput => ({
  role: 'main',
  hasCore: true,
  isVisible: true,
  readAt: null,
  autoTextAt: null,
  mentions: { chapters: [1] },
  ...over,
});
const chapters = (n: number) => ({ chapters: Array.from({ length: n }, (_, i) => i + 1) });

describe('computeWorldListed (F08-1, R1, PM-3)', () => {
  it('главный с ядром, без текста модели — на сайте', () => {
    expect(computeWorldListed(main())).toBe(true);
  });

  it('без ядра — нет', () => {
    expect(computeWorldListed(main({ hasCore: false }))).toBe(false);
  });

  it('readAt < autoTextAt — нет (текст модели не прочитан)', () => {
    const autoTextAt = at('2026-11-14T10:00:00.000Z');
    expect(computeWorldListed(main({ autoTextAt, readAt: at('2026-11-14T09:59:59.999Z') }))).toBe(
      false,
    );
  });

  it('readAt = autoTextAt — да', () => {
    const autoTextAt = at('2026-11-14T10:00:00.000Z');
    expect(computeWorldListed(main({ autoTextAt, readAt: new Date(autoTextAt) }))).toBe(true);
  });

  it('текст модели есть, отметки нет — нет', () => {
    expect(computeWorldListed(main({ autoTextAt: at('2026-11-14T10:00:00Z') }))).toBe(false);
  });

  it('autoTextAt = null — отметка «прочитано» не нужна', () => {
    expect(computeWorldListed(main({ autoTextAt: null, readAt: null }))).toBe(true);
  });

  it('isVisible = false — нет', () => {
    expect(computeWorldListed(main({ isVisible: false }))).toBe(false);
  });

  it(`второстепенный: ${WORLD_MIN_CHAPTERS - 1} главы — нет, ${WORLD_MIN_CHAPTERS} — да`, () => {
    expect(WORLD_MIN_CHAPTERS).toBe(3);
    const secondary = (n: number) => main({ role: 'secondary', mentions: chapters(n) });
    expect(computeWorldListed(secondary(WORLD_MIN_CHAPTERS - 1))).toBe(false);
    expect(computeWorldListed(secondary(WORLD_MIN_CHAPTERS))).toBe(true);
  });

  it('эпизодический и без роли — никогда', () => {
    expect(computeWorldListed(main({ role: 'minor', mentions: chapters(10) }))).toBe(false);
    expect(computeWorldListed(main({ role: null, mentions: chapters(10) }))).toBe(false);
  });
});

describe('isWorldEntityPublic и WORLD_ENTITY_PUBLIC_WHERE (F08-1, R1)', () => {
  it('черновик версии — не публична даже с isListed', () => {
    expect(isWorldEntityPublic({ isListed: true }, { status: 'draft' })).toBe(false);
    expect(isWorldEntityPublic({ isListed: true }, { status: 'published' })).toBe(true);
    expect(isWorldEntityPublic({ isListed: false }, { status: 'published' })).toBe(false);
  });

  it('условие выборки — ровно { isListed: true }', () => {
    expect(WORLD_ENTITY_PUBLIC_WHERE).toEqual({ isListed: true });
  });

  // Сырой `UPDATE` публикации (`stampWorldFirstPublished`) — то же условие, что выборки:
  // расхождение поставило бы `firstPublishedAt` сущности, которой нет на сайте.
  it('SQL-условие публикации совпадает с WORLD_ENTITY_PUBLIC_WHERE', () => {
    expect(Object.keys(WORLD_ENTITY_PUBLIC_WHERE)).toEqual(['isListed']);
    expect(WORLD_ENTITY_PUBLIC_SQL.sql).toBe('"isListed" = true');
    expect(WORLD_ENTITY_PUBLIC_SQL.values).toEqual([]);
  });
});

describe('worldListedWrite (F08-1, R2)', () => {
  const now = at('2026-11-14T12:00:00.000Z');

  it('впервые на сайте при опубликованной версии — firstPublishedAt = now', () => {
    expect(
      worldListedWrite({ ...main(), firstPublishedAt: null }, { status: 'published' }, now),
    ).toEqual({ isListed: true, firstPublishedAt: now });
  });

  it('черновик версии — isListed пишется, firstPublishedAt нет', () => {
    expect(
      worldListedWrite({ ...main(), firstPublishedAt: null }, { status: 'draft' }, now),
    ).toEqual({ isListed: true });
  });

  it('firstPublishedAt не сбрасывается и не переписывается', () => {
    const first = at('2026-11-01T00:00:00.000Z');
    expect(
      worldListedWrite(
        { ...main({ isVisible: false }), firstPublishedAt: first },
        { status: 'published' },
        now,
      ),
    ).toEqual({ isListed: false });
    expect(
      worldListedWrite({ ...main(), firstPublishedAt: first }, { status: 'published' }, now),
    ).toEqual({ isListed: true });
  });
});

describe('пара героев (F08-8c, решение арбитра `F08 | F08-8c` Q3)', () => {
  const pair = (over: Partial<WorldListedInput> = {}) =>
    main({ type: 'pair', role: null, hasListedMembers: true, ...over });
  // Рубильник R2 (`F08 | F08-8c-1`): с `F08-8c-2` включён по умолчанию; выключенное положение
  // проверяется отдельным тестом и возвращается.
  afterEach(() => {
    WORLD_PAIRS.public = true;
  });

  it('рубильник включён по умолчанию — пара с обоими героями на сайте', () => {
    expect(WORLD_PAIRS.public).toBe(true);
    expect(computeWorldListed(pair())).toBe(true);
  });

  it('рубильник выключен — пара не на сайте, герой — на сайте', () => {
    WORLD_PAIRS.public = false;
    expect(computeWorldListed(pair())).toBe(false);
    expect(computeWorldListed(main())).toBe(true);
  });

  it('pairMembersIn: оба героя ключа в наборе; один, ни одного или не ключ пары — нет', () => {
    const listed = new Set(['anna', 'tom']);
    expect(pairMembersIn('anna--tom', listed)).toBe(true);
    expect(pairMembersIn('anna--olga', listed)).toBe(false);
    expect(pairMembersIn('olga--zed', listed)).toBe(false);
    expect(pairMembersIn('anna', listed)).toBe(false);
  });

  it('heroesFirst: герои раньше пар, порядок внутри типа не меняется', () => {
    const rows = [
      { key: 'a--b', type: 'pair' },
      { key: 'b', type: 'character' },
      { key: 'c--d', type: 'pair' },
      { key: 'a', type: 'character' },
    ];
    expect([...rows].sort(heroesFirst).map((r) => r.key)).toEqual(['b', 'a', 'a--b', 'c--d']);
  });

  it('пара с ядром, прочитанная, оба героя на сайте — на сайте без роли', () => {
    expect(computeWorldListed(pair())).toBe(true);
  });

  it('герой пары не на сайте или не прочитан — пары нет; своё ядро и «показывать» — тоже', () => {
    expect(computeWorldListed(pair({ hasListedMembers: false }))).toBe(false);
    expect(computeWorldListed(pair({ hasListedMembers: undefined }))).toBe(false);
    expect(computeWorldListed(pair({ hasCore: false }))).toBe(false);
    expect(computeWorldListed(pair({ isVisible: false }))).toBe(false);
    const autoTextAt = at('2026-11-19T10:00:00.000Z');
    expect(computeWorldListed(pair({ autoTextAt, readAt: null }))).toBe(false);
  });

  it('герой с ролью не читает hasListedMembers', () => {
    expect(computeWorldListed(main({ hasListedMembers: false }))).toBe(true);
  });

  it('worldMembersReader: один запрос героев на все пары транзакции; у героя — undefined', async () => {
    const findMany = jest.fn().mockResolvedValue([{ key: 'anna' }, { key: 'tom' }]);
    const tx = { bookWorldEntity: { findMany } } as unknown as Parameters<
      typeof worldMembersReader
    >[0];
    const read = worldMembersReader(tx, 'v1');

    expect(await read({ key: 'anna', type: 'character' })).toBeUndefined();
    // Героев без пар запрос не читает вовсе.
    expect(findMany).not.toHaveBeenCalled();
    const answers = await Promise.all([
      read({ key: 'anna--tom', type: 'pair' }),
      read({ key: 'anna--olga', type: 'pair' }),
      read({ key: 'olga--tom', type: 'pair' }),
    ]);
    expect(await read({ key: 'anna--tom', type: 'pair' })).toBe(true);

    expect(answers).toEqual([true, false, false]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0]).toEqual({
      where: { bookVersionId: 'v1', type: 'character', isListed: true },
      select: { key: true },
      take: BOOK_WORLD_LIMITS.entities,
    });
  });

  it('relistWorldPairs: пишет только пары со сменившимся isListed, с прежним updatedAt', async () => {
    const updatedAt = at('2026-11-19T09:00:00.000Z');
    const row = (key: string, isListed: boolean) => ({
      key,
      type: 'pair',
      role: null,
      hasCore: true,
      isVisible: true,
      readAt: null,
      autoTextAt: null,
      mentions: { chapters: [1] },
      isListed,
      firstPublishedAt: at('2026-11-18T00:00:00.000Z'),
      updatedAt,
    });
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([
        row('anna--tom', true),
        row('anna--olga', false),
        row('olga--tom', false),
      ])
      .mockResolvedValueOnce([{ key: 'anna' }, { key: 'olga' }]);
    const update = jest.fn().mockResolvedValue({});
    const tx = { bookWorldEntity: { findMany, update } } as unknown as Parameters<
      typeof relistWorldPairs
    >[0];

    const written = await relistWorldPairs(
      tx,
      'v1',
      { status: 'published' },
      at('2026-11-19T10:00:00.000Z'),
    );

    // anna--tom: Том не на сайте — уходит; anna--olga: оба на сайте — приходит; olga--tom — без изменений.
    expect(written).toBe(2);
    expect(update.mock.calls.map(([args]: [unknown]) => args)).toEqual([
      {
        where: { bookVersionId_key: { bookVersionId: 'v1', key: 'anna--tom' } },
        data: { isListed: false, updatedAt },
      },
      {
        where: { bookVersionId_key: { bookVersionId: 'v1', key: 'anna--olga' } },
        data: { isListed: true, updatedAt },
      },
    ]);
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: { bookVersionId: 'v1', type: 'pair' },
    });
    expect(findMany.mock.calls[1][0]).toMatchObject({
      where: { bookVersionId: 'v1', type: 'character', isListed: true },
    });
  });

  it('relistWorldPairs: пара впервые на сайте опубликованной версии — пишется и firstPublishedAt (R2 F08-1)', async () => {
    const now = at('2026-11-19T10:00:00.000Z');
    const updatedAt = at('2026-11-19T09:00:00.000Z');
    const pairRow = (key: string, isListed: boolean) => ({
      key,
      type: 'pair',
      role: null,
      hasCore: true,
      isVisible: true,
      readAt: null,
      autoTextAt: null,
      mentions: { chapters: [1] },
      isListed,
      firstPublishedAt: null,
      updatedAt,
    });
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([pairRow('anna--tom', false), pairRow('anna--olga', true)])
      .mockResolvedValueOnce([{ key: 'anna' }, { key: 'tom' }, { key: 'olga' }]);
    const update = jest.fn().mockResolvedValue({});
    const tx = { bookWorldEntity: { findMany, update } } as unknown as Parameters<
      typeof relistWorldPairs
    >[0];

    // anna--tom приходит на сайт; anna--olga уже isListed, но без отметки первого показа — получает её.
    expect(await relistWorldPairs(tx, 'v1', { status: 'published' }, now)).toBe(2);
    expect(update.mock.calls.map(([args]: [{ data: unknown }]) => args.data)).toEqual([
      { isListed: true, firstPublishedAt: now, updatedAt },
      { isListed: true, firstPublishedAt: now, updatedAt },
    ]);
  });
});

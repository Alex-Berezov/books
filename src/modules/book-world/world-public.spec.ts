import {
  computeWorldListed,
  isWorldEntityPublic,
  WORLD_ENTITY_PUBLIC_SQL,
  WORLD_ENTITY_PUBLIC_WHERE,
  WORLD_MIN_CHAPTERS,
  worldListedWrite,
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

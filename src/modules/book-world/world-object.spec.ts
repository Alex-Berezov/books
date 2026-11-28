import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { StoredWorldEntity, WorldEventCardRow } from './book-world-data';
import { BOOK_WORLD_LIMITS } from './dto/book-world-blocks.dto';
import { BookWorldEntityInputDto } from './dto/update-book-world.dto';
import {
  WORLD_BLOCKS_OF_TYPE,
  WORLD_CHARACTER_BLOCK_KEYS,
  WORLD_EVENT_BLOCK_KEYS,
  WORLD_OBJECT_BLOCK_KEYS,
  WORLD_TERM_BLOCK_KEYS,
  toEntityDto,
  toObjectCard,
} from './book-world-data';
import { computeWorldCore, eventSceneChapters, WORLD_EVENT_CORE } from './world-core';
import { eventMentions } from './world-mentions-count';
import { computeWorldListed, WORLD_OBJECTS, WORLD_PLACES, worldCardShown } from './world-public';
import { worldItemKey } from './world-quote-check';
import {
  checkThemeKeys,
  checkWorldRefs,
  checkWorldTypeFields,
  entitiesReferring,
} from './world-refs';
import { byFirstChapter } from './world-object-cards';

/**
 * Предмет, понятие и событие (`F08-13a`, решения арбитра `F08 | F08-13` Q1, Q4, Q6, Q7): явные
 * перечни полей, ядро на границах, связи с героями и темами, рубильник `WORLD_OBJECTS`, глоссарий.
 */
const entity = (over: Partial<StoredWorldEntity> = {}): StoredWorldEntity => ({
  key: 'robe',
  type: 'object',
  name: 'The robe',
  role: null,
  aliases: null,
  sources: null,
  short: 'An oriental robe.',
  profile: null,
  appearance: null,
  character: null,
  arc: null,
  scenes: null,
  relations: null,
  quotes: null,
  critique: null,
  prototypes: null,
  adaptations: null,
  compare: null,
  bonds: null,
  differences: null,
  conclusion: null,
  kind: null,
  location: null,
  significance: 'The sign of his idleness.',
  description: null,
  wikidataId: null,
  imageBrief: null,
  imageBriefFor: null,
  faq: null,
  characterKeys: null,
  themeKeys: null,
  ...over,
});
const scene = (chapter: number) => ({ chapter, title: `Scene ${chapter}`, text: 'Text.' });
const noExclusions = { aliasExclusions: null, aliasChapterExclusions: null };
const counted = { chapters: [1] };
const ctx = {
  entityKeys: new Set(['robe', 'oblomov']),
  characterKeys: new Set(['oblomov']),
  analysisKeys: new Set(['oblomov', 'zakhar']),
};
const themes = new Set(['idleness']);

/** Все главы есть в версии: правило карточки здесь не проверяется (`world-object-cards.spec.ts`). */
const anyChapter = () => true;

describe('перечни полей (F08-13a, Q1): явные, без «всё прочее»', () => {
  it('поля героя — прежний состав, ни одного поля нового типа', () => {
    expect([...WORLD_CHARACTER_BLOCK_KEYS].sort()).toEqual(
      [
        'adaptations',
        'appearance',
        'arc',
        'character',
        'critique',
        'imageBrief',
        'imageBriefFor',
        'profile',
        'prototypes',
        'relations',
        'scenes',
      ].sort(),
    );
    expect([...WORLD_BLOCKS_OF_TYPE.character]).not.toContain('characterKeys');
    expect([...WORLD_BLOCKS_OF_TYPE.character]).not.toContain('themeKeys');
  });

  it('у предмета, понятия и события свои перечни, ТЗ на картинку нет ни у кого (Q4)', () => {
    expect([...WORLD_BLOCKS_OF_TYPE.object]).toEqual([...WORLD_OBJECT_BLOCK_KEYS]);
    expect([...WORLD_BLOCKS_OF_TYPE.term]).toEqual([...WORLD_TERM_BLOCK_KEYS]);
    expect([...WORLD_BLOCKS_OF_TYPE.event]).toEqual([...WORLD_EVENT_BLOCK_KEYS]);
    for (const type of ['object', 'term', 'event'] as const) {
      expect(WORLD_BLOCKS_OF_TYPE[type].has('imageBrief')).toBe(false);
    }
  });

  it('поле нового типа у героя — 400 с путём (ловушка прежнего WORLD_CHARACTER_BLOCK_KEYS)', () => {
    const hero = entity({ type: 'character', role: 'main', significance: null });
    expect(
      checkWorldTypeFields(
        { ...hero, characterKeys: ['oblomov'], themeKeys: ['idleness'] },
        noExclusions,
      ).map((e) => e.path),
    ).toEqual(['characterKeys', 'themeKeys']);
  });

  it('поле героя, место и ТЗ у предмета — 400; роль и источники — 400', () => {
    const errors = checkWorldTypeFields(
      entity({
        character: 'Kind.',
        kind: 'real',
        imageBrief: 'A robe',
        role: 'main',
        sources: [{ title: 'x', url: 'https://example.org' }],
      }),
      noExclusions,
    );
    expect(errors.map((e) => e.path)).toEqual([
      'character',
      'kind',
      'imageBrief',
      'role',
      'sources',
    ]);
  });

  it('понятию нельзя сцены, описания и связей; событию — описания и тем', () => {
    const term = entity({
      type: 'term',
      scenes: [scene(1)],
      description: 'D',
      characterKeys: ['oblomov'],
      faq: [{ question: 'Q', answer: 'A' }],
    });
    expect(checkWorldTypeFields(term, noExclusions).map((e) => e.path)).toEqual([
      'description',
      'scenes',
      'faq',
      'characterKeys',
    ]);
    const event = entity({ type: 'event', description: 'D', themeKeys: ['idleness'] });
    expect(checkWorldTypeFields(event, noExclusions).map((e) => e.path)).toEqual([
      'description',
      'themeKeys',
    ]);
  });
});

describe('ядро (F08-13a, Q1)', () => {
  it('предмет: «Коротко», значение и хотя бы одна глава присутствия', () => {
    expect(computeWorldCore({ ...entity(), mentions: counted }).hasCore).toBe(true);
    const empty = computeWorldCore({
      ...entity({ short: null, significance: ' ' }),
      mentions: { chapters: [] },
    });
    expect(empty.missing).toEqual([
      { part: 'short', have: 0, need: 1 },
      { part: 'significance', have: 0, need: 1 },
      { part: 'mentions', have: 0, need: 1 },
    ]);
  });

  it('понятие: «Коротко» и присутствие; значение необязательно', () => {
    const term = entity({ type: 'term', significance: null });
    expect(computeWorldCore({ ...term, mentions: counted }).hasCore).toBe(true);
    expect(computeWorldCore({ ...term, mentions: null }).missing).toEqual([
      { part: 'mentions', have: 0, need: 1 },
    ]);
  });

  it('событие: порог сцен ровно 1 с главой, присутствие по формам не нужно', () => {
    expect(WORLD_EVENT_CORE.scenes).toBe(1);
    const event = entity({ type: 'event', scenes: [scene(9)] });
    expect(computeWorldCore({ ...event, mentions: null }).hasCore).toBe(true);
    const none = computeWorldCore({ ...event, scenes: [], mentions: counted });
    expect(none.missing).toEqual([{ part: 'scenes', have: 0, need: 1 }]);
  });

  it('событие без значения — не ядро', () => {
    const event = entity({ type: 'event', scenes: [scene(9)], significance: null });
    expect(computeWorldCore({ ...event, mentions: null }).missing).toEqual([
      { part: 'significance', have: 0, need: 1 },
    ]);
  });

  it('несошедшаяся сцена события в ядро не идёт', () => {
    const event = entity({ type: 'event', scenes: [scene(9)] });
    const stale = worldItemKey('scenes', scene(9));
    expect(computeWorldCore({ ...event, mentions: { stale: [stale] } }).missing).toEqual([
      { part: 'scenes', have: 0, need: 1 },
    ]);
  });
});

describe('главы события (F08-13a, Q1, R2): формы ∪ сцены, одно правило подсчёта', () => {
  const none = { chapters: [], first: null, perChapter: {}, paragraphs: {}, coPresence: {} };
  const inVersion = (n: number) => n <= 10;

  it('формы ничего не нашли — главы сцен, что есть в версии, по возрастанию без повторов', () => {
    const got = eventMentions(
      { type: 'event', scenes: [scene(9), scene(3), scene(9), scene(12)] },
      none,
      inVersion,
    );
    expect(got.chapters).toEqual([3, 9]);
    expect(got.first).toBe(3);
  });

  it('форма нашлась в одной главе, сцены в 3 и 7 — в главах все три, первая — наименьшая', () => {
    const found = {
      ...none,
      chapters: [5],
      first: 5,
      perChapter: { '5': 1 },
      paragraphs: { '5': [0] },
    };
    const got = eventMentions({ type: 'event', scenes: [scene(7), scene(3)] }, found, inVersion);
    expect(got.chapters).toEqual([3, 5, 7]);
    expect(got.first).toBe(3);
    // Счёт и абзацы — только по формам: у сцены их нет.
    expect(got.perChapter).toEqual({ '5': 1 });
    expect(got.paragraphs).toEqual({ '5': [0] });
  });

  it('главы сцен (R3): целые номера без повторов по возрастанию; не массив и не номер — не глава', () => {
    expect(eventSceneChapters([scene(10), scene(2), scene(10)])).toEqual([2, 10]);
    expect(eventSceneChapters([{ chapter: '3' }, { chapter: 1.5 }, null, scene(4)])).toEqual([4]);
    expect(eventSceneChapters({ chapter: 1 })).toEqual([]);
    expect(eventSceneChapters(null)).toEqual([]);
  });

  it('не событие — подсчёт как есть', () => {
    expect(eventMentions({ type: 'object', scenes: [scene(9)] }, none, inVersion)).toBe(none);
  });
});

describe('связи с героями и темами (F08-13a, Q1)', () => {
  it('characterKeys — только герои мира: ключ героя анализа без героя мира — 400', () => {
    const errors = checkWorldRefs(entity({ characterKeys: ['oblomov', 'zakhar'] }), ctx);
    expect(errors).toEqual([
      { path: 'characterKeys.1', message: '"zakhar" is not a character of this world' },
    ]);
  });

  it('themeKeys из тела (R1) — только темы анализа версии; нет поля в теле — не проверяется', () => {
    expect(checkThemeKeys(['idleness', 'love'], null, themes)).toEqual([
      { path: 'themeKeys.1', message: '"love" is not a theme of the analysis of this version' },
    ]);
    expect(checkThemeKeys(['idleness'], null, themes)).toEqual([]);
    expect(checkThemeKeys(undefined, null, new Set())).toEqual([]);
    // Форма вернула сохранённый устаревший ключ из GET — правка сохраняется; новый неизвестный — 400.
    expect(checkThemeKeys(['love'], ['love'], themes)).toEqual([]);
    expect(checkThemeKeys(['love', 'war'], ['love'], themes).map((e) => e.path)).toEqual([
      'themeKeys.1',
    ]);
    // Сохранённый устаревший ключ слитой сущности ссылкой не считается (`checkWorldRefs`).
    expect(checkWorldRefs(entity({ themeKeys: ['love'] }), ctx)).toEqual([]);
  });

  it('читателю — только темы текущего анализа, редактору — все (R1)', () => {
    const row = {
      key: 'robe',
      type: 'object' as const,
      name: 'The robe',
      role: null,
      short: 'S',
      hasCore: true,
      isIndexable: true,
      mentionFirst: 1,
      updatedAt: new Date(0),
      aliases: null,
      blocks: { themeKeys: ['idleness', 'love'] },
      sources: null,
      mentions: null,
      geo: null,
      createdAt: new Date(0),
    };
    expect(
      toEntityDto(row, { visibleKeys: new Set(), themeKeys: new Set(['love']) }).themeKeys,
    ).toEqual(['love']);
    expect(toEntityDto(row).themeKeys).toEqual(['idleness', 'love']);
  });

  it('читателю — только публичные герои предмета (visibleKeys), редактору — все', () => {
    const row = {
      key: 'robe',
      type: 'object' as const,
      name: 'The robe',
      role: null,
      short: 'S',
      hasCore: true,
      isIndexable: true,
      mentionFirst: 1,
      updatedAt: new Date(0),
      aliases: null,
      blocks: { characterKeys: ['oblomov', 'zakhar'] },
      sources: null,
      mentions: null,
      geo: null,
      createdAt: new Date(0),
    };
    expect(toEntityDto(row, { visibleKeys: new Set(['oblomov']) }).characterKeys).toEqual([
      'oblomov',
    ]);
    expect(toEntityDto(row).characterKeys).toEqual(['oblomov', 'zakhar']);
  });

  it('героя держит связь предмета, даже если его ключ есть у героя анализа', () => {
    const others = [{ key: 'robe', blocks: { characterKeys: ['oblomov'] } }];
    expect(entitiesReferring('oblomov', others, new Set(['oblomov']))).toEqual(['robe']);
    // Отношение героя на ключ героя анализа по-прежнему не держит (`checkWorldRefs` его принимает).
    const relation = [{ key: 'olga', blocks: { relations: [{ to: 'oblomov', label: 'L' }] } }];
    expect(entitiesReferring('oblomov', relation, new Set(['oblomov']))).toEqual([]);
  });
});

describe('рубильник WORLD_OBJECTS (F08-13a, Q6)', () => {
  const listed = {
    role: null,
    hasCore: true,
    isVisible: true,
    readAt: null,
    autoTextAt: null,
    mentions: counted,
  };
  afterEach(() => {
    WORLD_OBJECTS.public = true;
    WORLD_PLACES.public = true;
  });

  it('включённый — роль у типа не учитывается (ни minor, ни без роли не мешают)', () => {
    WORLD_OBJECTS.public = true;
    for (const type of ['object', 'term', 'event']) {
      expect(computeWorldListed({ ...listed, type, role: 'minor', mentions: null })).toBe(true);
    }
  });

  it('включён по умолчанию с F08-13c (Q6)', () => {
    expect(WORLD_OBJECTS.public).toBe(true);
  });

  it('выключенный: ни предмет, ни понятие, ни событие не на сайте', () => {
    WORLD_OBJECTS.public = false;
    for (const type of ['object', 'term', 'event']) {
      expect(computeWorldListed({ ...listed, type })).toBe(false);
    }
  });

  it('включённый — страница по ядру без роли; без ядра или «прочитано» — нет', () => {
    WORLD_OBJECTS.public = true;
    for (const type of ['object', 'term', 'event']) {
      expect(computeWorldListed({ ...listed, type })).toBe(true);
      expect(computeWorldListed({ ...listed, type, hasCore: false })).toBe(false);
      expect(
        computeWorldListed({ ...listed, type, autoTextAt: new Date(2), readAt: new Date(1) }),
      ).toBe(false);
    }
  });

  it('карточка предмета, понятия и события — под своим рубильником, «показывать» и «прочитано» (F08-13c Q2)', () => {
    for (const type of ['object', 'term', 'event']) {
      const card = { type, isVisible: true, readAt: null, autoTextAt: null };
      WORLD_OBJECTS.public = false;
      expect(worldCardShown(card)).toBe(false);
      WORLD_OBJECTS.public = true;
      WORLD_PLACES.public = false;
      expect(worldCardShown(card)).toBe(true);
      expect(worldCardShown({ ...card, isVisible: false })).toBe(false);
      expect(worldCardShown({ ...card, autoTextAt: new Date(2), readAt: new Date(1) })).toBe(false);
    }
    expect(worldCardShown({ type: 'place', isVisible: true, readAt: null, autoTextAt: null })).toBe(
      false,
    );
    expect(
      worldCardShown({ type: 'character', isVisible: true, readAt: null, autoTextAt: null }),
    ).toBe(false);
  });
});

describe('карточки общей страницы (F08-13a Q7, F08-13c Q2)', () => {
  const eventRow = (scenes: unknown, mentions: unknown = null): WorldEventCardRow =>
    ({
      key: 'duel',
      type: 'event',
      name: 'The duel',
      short: 'Two men meet at dawn.',
      mentionFirst: 1,
      isListed: true,
      isVisible: true,
      readAt: null,
      autoTextAt: null,
      blocks: { scenes },
      mentions,
    }) as unknown as WorldEventCardRow;

  it('событие: глава — первая глава сцен, а не первое упоминание формы; сцен в карточке нет', () => {
    expect(
      toObjectCard(
        eventRow([
          { title: 'Dawn', text: 'They meet.', chapter: 7 },
          { title: 'Shot', text: 'One falls.', chapter: 5 },
        ]),
        anyChapter,
      ),
    ).toEqual({
      key: 'duel',
      name: 'The duel',
      short: 'Two men meet at dawn.',
      chapter: 5,
      hasPage: true,
    });
  });

  it('событие без сцен с главой — глава null; устаревшая сцена не считается', () => {
    expect(toObjectCard(eventRow(null), anyChapter).chapter).toBeNull();
    expect(
      toObjectCard(eventRow([{ title: 'x', text: 'y', chapter: null }]), anyChapter).chapter,
    ).toBeNull();
    const stale = {
      stale: [worldItemKey('scenes', { title: 'Shot', text: 'One falls.', chapter: 5 })],
    };
    expect(
      toObjectCard(
        eventRow(
          [
            { title: 'Dawn', text: 'They meet.', chapter: 7 },
            { title: 'Shot', text: 'One falls.', chapter: 5 },
          ],
          stale,
        ),
        anyChapter,
      ).chapter,
    ).toBe(7);
  });

  it('событие: мусор в сценах (null, не объект) не роняет карточку, сцена без текста главы не даёт', () => {
    expect(
      toObjectCard(
        eventRow([null, 'x', { title: 'Shot', text: 'One falls.', chapter: 5 }]),
        anyChapter,
      ).chapter,
    ).toBe(5);
    expect(
      toObjectCard(
        eventRow([
          { title: 'Empty', text: '', chapter: 2 },
          { title: 'Shot', text: 'One falls.', chapter: 5 },
        ]),
        anyChapter,
      ).chapter,
    ).toBe(5);
  });

  it('строка белым списком: термин, определение, первая глава, своя страница', () => {
    expect(
      toObjectCard(
        {
          key: 'oblomovism',
          type: 'term',
          name: 'Oblomovism',
          short: 'Idle apathy.',
          mentionFirst: 4,
          isListed: false,
          isVisible: true,
          readAt: null,
          autoTextAt: null,
        },
        anyChapter,
      ),
    ).toEqual({
      key: 'oblomovism',
      name: 'Oblomovism',
      short: 'Idle apathy.',
      chapter: 4,
      hasPage: false,
    });
  });

  it('порядок: по первой главе, без главы — в конце, равные — по ключу кодом символа', () => {
    const rows = [
      { key: 'b', chapter: null },
      { key: 'z', chapter: 2 },
      { key: 'a', chapter: null },
      { key: 'B', chapter: 2 },
      { key: 'c', chapter: 1 },
    ];
    expect([...rows].sort(byFirstChapter).map((r) => r.key)).toEqual(['c', 'B', 'z', 'a', 'b']);
  });
});

describe('WorldKeyList (F08-13a): ключи связей на входе', () => {
  const body = (over: Record<string, unknown>) =>
    validate(
      plainToInstance(BookWorldEntityInputDto, { key: 'robe', type: 'object', name: 'R', ...over }),
    );
  const failed = async (over: Record<string, unknown>) => (await body(over)).map((e) => e.property);

  it('ключи по правилу ключа, без повторов, не больше предела', async () => {
    expect(await failed({ characterKeys: ['oblomov'], themeKeys: ['idleness'] })).toEqual([]);
    expect(await failed({ characterKeys: ['Oblomov'] })).toEqual(['characterKeys']);
    expect(await failed({ characterKeys: ['a', 'a'] })).toEqual(['characterKeys']);
    expect(await failed({ themeKeys: [1] })).toEqual(['themeKeys']);
    const many = Array.from({ length: BOOK_WORLD_LIMITS.characterKeys + 1 }, (_, i) => `k${i}`);
    expect(await failed({ characterKeys: many })).toEqual(['characterKeys']);
  });
});

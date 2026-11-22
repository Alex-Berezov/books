import {
  readAliasChapterExclusions,
  WORLD_EDITOR_SUMMARY_SELECT,
  WORLD_READER_SUMMARY_SELECT,
  WORLD_SUMMARY_SELECT,
  editorOf,
  mergeEntity,
  readStoredEntity,
  readMentions,
  toEntityDto,
  toReaderSummary,
  worldContentChanged,
  type StoredWorldEntity,
} from './book-world-data';
import { worldCompareKey, worldItemKey } from './world-quote-check';

/**
 * F08-1, решение арбитра R9: импорт ставит `autoTextAt` только сущности, у которой после слияния
 * изменилось содержание. Сравнение — по хранимому виду, порядок ключей Json не в счёт (`jsonb`
 * его не хранит).
 */
const stored = (over: Partial<StoredWorldEntity> = {}): StoredWorldEntity => ({
  key: 'oblomov',
  type: 'character',
  name: 'Oblomov',
  role: 'main',
  aliases: ['Ilya'],
  short: 'Who he is.',
  sources: null,
  profile: { position: 'landowner', relationToMain: 'himself' },
  appearance: null,
  character: 'Kind.',
  arc: { from: 'a', to: 'b' },
  scenes: null,
  relations: null,
  quotes: [{ text: 'Q', chapter: 1, interpretation: 'I' }],
  critique: null,
  prototypes: null,
  adaptations: null,
  compare: null,
  bonds: null,
  differences: null,
  conclusion: null,
  faq: null,
  ...over,
});

describe('worldContentChanged (F08-1, R9)', () => {
  it('новая сущность — изменение', () => {
    expect(worldContentChanged(null, stored())).toBe(true);
  });

  it('тело без полей — без изменений', () => {
    const before = stored();
    expect(
      worldContentChanged(before, mergeEntity(before, { key: 'oblomov', type: 'character' })),
    ).toBe(false);
  });

  it('то же значение — без изменений; другой порядок ключей Json — тоже', () => {
    const before = stored();
    const reordered = stored({ profile: { relationToMain: 'himself', position: 'landowner' } });
    expect(worldContentChanged(before, reordered)).toBe(false);
    expect(
      worldContentChanged(
        before,
        mergeEntity(before, { key: 'oblomov', type: 'character', short: ' Who he is. ' }),
      ),
    ).toBe(false);
  });

  // F08-10a: номер абзаца сцены не хранится и не меняет содержание - его считает выдача.
  it('сцена с номером абзаца из GET - без изменений, номер не хранится', () => {
    const scene = { chapter: 1, title: 'T', text: 'S' };
    const before = stored({ scenes: [scene] });
    const merged = mergeEntity(before, {
      key: 'oblomov',
      type: 'character',
      scenes: [{ ...scene, paragraph: 3 }],
    });
    expect(worldContentChanged(before, merged)).toBe(false);
    expect(merged.scenes).toEqual([scene]);
  });

  it('хранимая сцена с номером (запись до F08-10a) - номер снят при чтении, без изменений', () => {
    const scene = { chapter: 1, title: 'T', text: 'S' };
    const row = {
      key: 'oblomov',
      type: 'character' as const,
      name: 'Oblomov',
      role: 'main',
      aliases: null,
      short: 'Who.',
      sources: null,
      blocks: { scenes: [{ ...scene, paragraph: 7 }] },
    } as unknown as Parameters<typeof readStoredEntity>[0];
    const existing = readStoredEntity(row);
    expect(existing.scenes).toEqual([scene]);
    const merged = mergeEntity(existing, { key: 'oblomov', type: 'character', short: 'Who.' });
    expect(worldContentChanged(existing, merged)).toBe(false);
  });

  it('мусор в хранимых сценах читается без падения', () => {
    const odd = (scenes: unknown) =>
      readStoredEntity({
        key: 'k',
        type: 'character',
        name: 'K',
        role: null,
        aliases: null,
        short: null,
        sources: null,
        blocks: { scenes },
      } as unknown as Parameters<typeof readStoredEntity>[0]).scenes;
    expect(odd({})).toEqual({});
    expect(odd([null])).toEqual([null]);
  });

  it('мусор в хранимых сценах - страница редактора отдаётся без падения', () => {
    const row = {
      key: 'k',
      type: 'character',
      name: 'K',
      role: null,
      aliases: null,
      short: null,
      sources: null,
      mentions: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    for (const scenes of [{}, [null]]) {
      const dto = toEntityDto({ ...row, blocks: { scenes } } as unknown as Parameters<
        typeof toEntityDto
      >[0]);
      expect(dto.scenes).toEqual(scenes);
    }
  });

  it('изменилось любое содержательное поле — изменение', () => {
    const before = stored();
    for (const over of [
      { short: 'Other.' },
      { name: 'Ilya Oblomov' },
      { role: 'secondary' as const },
      { aliases: null },
      { quotes: [{ text: 'Q2', chapter: 1, interpretation: 'I' }] },
      { sources: [{ title: 'S', url: 'https://example.com' }] },
    ]) {
      expect({ over, changed: worldContentChanged(before, stored(over)) }).toEqual({
        over,
        changed: true,
      });
    }
  });
});

describe('выборки списка (F08-1)', () => {
  // Список не тянет тексты страниц: строка — поля сводки, у редактора ещё отметки (`LEGACY-127` класс).
  it('строка списка читателя и редактора — без Json-колонок', () => {
    expect(Object.keys(WORLD_SUMMARY_SELECT).sort()).toEqual(
      // F08-3: первая глава присутствия — колонкой Int, не Json `mentions` (решение арбитра Q2).
      [
        'key',
        'type',
        'name',
        'role',
        'short',
        'hasCore',
        'isIndexable',
        'mentionFirst',
        'updatedAt',
      ].sort(),
    );
    expect(Object.keys(WORLD_EDITOR_SUMMARY_SELECT).sort()).toEqual(
      [
        ...Object.keys(WORLD_SUMMARY_SELECT),
        'isListed',
        'isVisible',
        'readAt',
        'autoTextAt',
        'firstPublishedAt',
        'coreMissing',
        // F08-2: число глав присутствия — колонкой Int, не Json `mentions`.
        'mentionChapters',
      ].sort(),
    );
  });
});

describe('формы имени в списке читателя (F08-5, решение арбитра Q2)', () => {
  it('строка читателя берёт колонки форм, но без текстов страницы', () => {
    expect(Object.keys(WORLD_READER_SUMMARY_SELECT).sort()).toEqual(
      [...Object.keys(WORLD_SUMMARY_SELECT), 'aliases', 'aliasExclusions'].sort(),
    );
  });

  it('forms без исключённых форм, исключения наружу не уходят', () => {
    const dto = toReaderSummary({
      key: 'vera',
      type: 'character',
      name: 'Вера',
      role: 'main',
      short: null,
      hasCore: true,
      isIndexable: true,
      mentionFirst: 1,
      updatedAt: new Date('2026-11-18T00:00:00Z'),
      aliases: ['Верочка', 'вера', 7],
      aliasExclusions: ['Верочка'],
    });
    expect(dto.forms).toEqual(['Вера']);
    expect(dto).not.toHaveProperty('aliasExclusions');
    expect(dto).not.toHaveProperty('aliases');
  });

  it('сущность без форм имени в колонке — только имя', () => {
    const dto = toReaderSummary({
      key: 'oblomov',
      type: 'character',
      name: 'Обломов',
      role: 'main',
      short: null,
      hasCore: true,
      isIndexable: true,
      mentionFirst: null,
      updatedAt: new Date('2026-11-18T00:00:00Z'),
      aliases: null,
      aliasExclusions: null,
    });
    expect(dto.forms).toEqual(['Обломов']);
  });
});

describe('присутствие наружу (F08-2, решения арбитра Q2, Q3)', () => {
  const mentions = {
    chapters: [1, 2, 3],
    first: 1,
    perChapter: { '3': 1, '1': 2, '2': 4 },
    paragraphs: { '1': [0] },
    coPresence: { ivan: [2], olga: [1, 3] },
    // Ключи по содержанию (S1): не номер пункта, а вид, глава, заголовок и текст.
    stale: [
      worldItemKey('quotes', { chapter: 1, text: 'gone' }),
      worldItemKey('scenes', { chapter: 9, title: 'gone', text: 'x' }),
      worldItemKey('arc.stages', { chapter: 9, title: 'S', text: 'T' }),
    ],
  };

  it('readMentions: ровно chapters/first/perChapter/coPresence, списками по порядку', () => {
    expect(readMentions(mentions)).toEqual({
      chapters: [1, 2, 3],
      first: 1,
      perChapter: [
        { chapter: 1, count: 2 },
        { chapter: 2, count: 4 },
        { chapter: 3, count: 1 },
      ],
      coPresence: [
        { key: 'ivan', chapters: [2] },
        { key: 'olga', chapters: [1, 3] },
      ],
    });
    expect(readMentions(null)).toBeNull();
  });

  it('readMentions читателю: в coPresence только публичные соседи', () => {
    expect(readMentions(mentions, new Set(['olga']))!.coPresence).toEqual([
      { key: 'olga', chapters: [1, 3] },
    ]);
    expect(readMentions(mentions, new Set())!.coPresence).toEqual([]);
  });

  const row = {
    key: 'oblomov',
    type: 'character' as const,
    name: 'Oblomov',
    role: 'main',
    short: 'Who he is.',
    hasCore: true,
    isIndexable: true,
    mentionFirst: 1,
    updatedAt: new Date(),
    createdAt: new Date(),
    aliases: null,
    sources: null,
    mentions,
    blocks: {
      arc: { from: 'A', to: 'B', stages: [{ title: 'S', text: 'T', chapter: 9 }] },
      scenes: [
        { chapter: 9, title: 'gone', text: 'x' },
        { chapter: 1, title: 'kept', text: 'y' },
      ],
      quotes: [
        { text: 'kept', chapter: 1, interpretation: 'i' },
        { text: 'gone', chapter: 1, interpretation: 'i' },
      ],
    },
  };

  it('toEntityDto читателю: пункты из stale не отдаются; редактору — все', () => {
    const reader = toEntityDto(row, { visibleKeys: new Set() });
    expect(reader.quotes!.map((q) => q.text)).toEqual(['kept']);
    expect(reader.scenes!.map((x) => x.title)).toEqual(['kept']);
    expect(reader.arc!.stages).toEqual([]);
    const editor = toEntityDto(row);
    expect(editor.quotes).toHaveLength(2);
    expect(editor.scenes).toHaveLength(2);
    expect(editor.arc!.stages).toHaveLength(1);
    expect(editor.mentions!.coPresence).toHaveLength(2);
  });

  // F08-10a, решение арбитра `F08 | F08-10a` Q1: абзац сцены - из свежего подсчёта, а не сохранённый.
  it('F08-10a: абзац сцены - первый абзац главы с формой имени (с 1), сохранённый не берётся', () => {
    const counted = { ...mentions, paragraphs: { '1': [4, 2], '9': [] } };
    const stored = {
      ...row,
      mentions: counted,
      blocks: {
        scenes: [
          { chapter: 1, title: 'kept', text: 'y', paragraph: 7 },
          { chapter: 2, title: 'no form', text: 'z' },
          { chapter: 9, title: 'empty', text: 'w', paragraph: 1 },
        ],
      },
    };
    for (const dto of [toEntityDto(stored), toEntityDto(stored, { visibleKeys: new Set() })]) {
      expect(dto.scenes!.map((x) => x.paragraph)).toEqual([3, null, null]);
    }
    // Номера абзацев наружу не отдаются: только число в сцене.
    expect(JSON.stringify(toEntityDto(stored).mentions)).not.toContain('paragraphs');
  });

  it('F08-10a: без посчитанных абзацев (старый подсчёт) - null, а не сохранённое значение', () => {
    const old = {
      ...row,
      mentions: { chapters: [1], first: 1 },
      blocks: { scenes: [{ chapter: 1, title: 't', text: 'x', paragraph: 5 }] },
    };
    expect(toEntityDto(old).scenes!.map((x) => x.paragraph)).toEqual([null]);
  });

  it('F08-10a: номер сверх предела входа и мусор в колонке - null', () => {
    const odd = {
      ...row,
      mentions: { ...mentions, paragraphs: { '1': [10_000], '2': [-1, 1.5, 'x'] } },
      blocks: {
        scenes: [
          { chapter: 1, title: 'far', text: 'x' },
          { chapter: 2, title: 'junk', text: 'y' },
        ],
      },
    };
    expect(toEntityDto(odd).scenes!.map((x) => x.paragraph)).toEqual([null, null]);
  });

  it('F08-3: первая глава присутствия — в сводке читателя (Q2)', () => {
    expect(toEntityDto(row, { visibleKeys: new Set() }).mentionFirst).toBe(1);
  });

  it('F08-5a: формы имени читаются одним разбором — нестроковые элементы колонки отбрасываются', () => {
    const odd = { ...row, aliases: ['Ilya Ilyich', 7, null] };
    expect(toEntityDto(odd, { visibleKeys: new Set() }).aliases).toEqual(['Ilya Ilyich']);
  });
});

describe('отметки редактора (F08-3, решение арбитра Q3)', () => {
  const marks = {
    key: 'oblomov',
    type: 'character' as const,
    name: 'Oblomov',
    role: 'main',
    short: null,
    hasCore: true,
    isIndexable: true,
    mentionFirst: null,
    updatedAt: new Date(),
    isVisible: true,
    readAt: null,
    autoTextAt: null,
    firstPublishedAt: null,
    coreMissing: [],
    mentionChapters: null,
  };

  it('editorOf отдаёт isListed как есть — вкладка не повторяет условие публичности', () => {
    expect(editorOf({ ...marks, isListed: true }).isListed).toBe(true);
    expect(editorOf({ ...marks, isListed: false }).isListed).toBe(false);
  });
});

describe('исключённые главы у формы из колонки (F08-8a)', () => {
  it('не массив — null; записи без строки формы или без целых глав отброшены', () => {
    expect(readAliasChapterExclusions(null)).toBeNull();
    expect(readAliasChapterExclusions({ form: 'Simon', chapters: [1] })).toBeNull();
    expect(
      readAliasChapterExclusions([
        { form: 'Simon', chapters: [6, 1.5, '7', 15] },
        { form: 'Peter', chapters: ['3', 2.5] },
        { form: 7, chapters: [1] },
        { form: 'Kifa' },
        'Simon: 6',
      ]),
    ).toEqual([{ form: 'Simon', chapters: [6, 15] }]);
  });
});

describe('пара читателю (F08-8c): несошедшаяся строка сравнения не отдаётся, форм нет', () => {
  const kept = { feature: 'Kept', a: 'A', chapterA: 1, b: 'B', chapterB: 2 };
  const gone = { feature: 'Gone', a: 'A', chapterA: 1, b: 'B', chapterB: 9 };
  const row = {
    key: 'anna--tom',
    type: 'pair' as const,
    name: 'Anna and Tom',
    role: null,
    short: 'Two.',
    hasCore: true,
    isIndexable: true,
    mentionFirst: 1,
    updatedAt: new Date(),
    createdAt: new Date(),
    aliases: null,
    aliasExclusions: null,
    sources: null,
    mentions: { chapters: [1], first: 1, stale: [worldCompareKey(gone)] },
    blocks: { compare: [gone, kept], conclusion: 'So.' },
  };

  it('читателю — без строки из stale; редактору — обе', () => {
    expect(toEntityDto(row, { visibleKeys: new Set() }).compare).toEqual([kept]);
    expect(toEntityDto(row).compare).toEqual([gone, kept]);
    expect(toEntityDto(row).conclusion).toBe('So.');
  });

  it('в списке читателя у пары нет форм имени — «A и B» не цель перелинковки', () => {
    expect(toReaderSummary(row).forms).toEqual([]);
  });
});

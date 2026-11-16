import { Language, Prisma, type PrismaClient } from '@prisma/client';
import {
  type EnsureRights,
  pruneAcceptanceVersions,
  seedSeoRobots,
  upsertAcceptanceBook,
  upsertAcceptanceChapters,
  upsertAcceptanceVersion,
} from './seed-acceptance';

/**
 * Мир книги для приёмки публичных страниц (`F08-3`, `books-front` e2e;
 * `books-app-docs/features/F08-book-wiki/batches.md` F08-3 «Посадка»). Книги служебные, вне
 * `SEO_CATALOG_BOOKS`: точные числа каталога в `test/seed-dataset.e2e-spec.ts` от них не меняются.
 *
 * - `world-acceptance` — `en` и `ru`:
 *   - `anna-lark` — полный герой (все блоки), на обоих языках — hreflang из двух;
 *   - `tom-reed` — минимальный герой: только ядро;
 *   - `mira-vale` — страница есть, `isIndexable=false` (200 с `noindex`, вне карты и hreflang);
 *   - `ned-fox` — ядро и «прочитано», но `isVisible=false` — 404;
 *   - `sam-holt` — ядро, текст модели не прочитан — 404;
 *   - `lou-grey` — без ядра (нет цитат и сцен) — 404;
 * - `world-acceptance-noindex` — `en` с редакторским `noindex`: мир есть, но закрыт от индекса.
 * - `world-acceptance-hidden` — `en`, сущность мира есть, но скрыта (`isVisible=false`): `/wiki` — 404.
 *
 * Производные поля (`mentions`, `hasCore`, `coreMissing`, `isListed`, `mentionChapters`,
 * `mentionFirst`) записаны литералами: функции подсчёта живут в `src/`, а `src/` в образе сиду
 * недоступен. Что литералы совпадают с настоящим подсчётом (пересчёт версии ничего не пишет), держит
 * `test/seed-dataset.e2e-spec.ts`.
 */
export const WORLD_ACCEPTANCE = {
  book: 'world-acceptance',
  noindex: 'world-acceptance-noindex',
  hidden: 'world-acceptance-hidden',
} as const;

/** Служебные строки версии на её языке: на ru-странице не должно быть английских фраз (§1 п.9). */
const WORDS: Partial<Record<Language, { title: string; description: string; chapter: string }>> = {
  en: {
    title: 'World Acceptance',
    description: 'Service book for the book world acceptance.',
    chapter: 'Chapter',
  },
  ru: {
    title: 'Приёмка мира книги',
    description: 'Служебная книга приёмки мира книги.',
    chapter: 'Глава',
  },
};
const wordsOf = (language: Language) => WORDS[language] ?? WORDS.en!;

/** Абзацы глав `en`: имена героев стоят в известных абзацах — по ним литералы `mentions` ниже. */
const CHAPTERS_EN: Record<number, string[]> = {
  1: [
    'Anna Lark opened the old map at dawn.',
    'Tom Reed watched from the door.',
    'Anna Lark said the river would rise.',
    'Lou Grey sang in the yard.',
  ],
  2: [
    'The river rose before noon.',
    'Anna Lark and Tom Reed crossed the bridge together.',
    'Mira Vale waited on the far bank.',
    'Sam Holt counted the boats.',
  ],
  3: [
    'Tom Reed lit the lamp in the tower.',
    'Anna Lark closed the map for the last time.',
    'Ned Fox kept the keys.',
  ],
};

const CHAPTERS_RU: Record<number, string[]> = {
  1: ['Анна Ларк открыла старую карту на рассвете.', 'Река шумела под окнами.'],
  2: ['Анна Ларк перешла мост до полудня.', 'Вода поднялась к вечеру.'],
  3: ['Анна Ларк закрыла карту в последний раз.'],
};

const html = (paragraphs: string[]) => paragraphs.map((p) => `<p>${p}</p>`).join('');

type Mentions = {
  chapters: number[];
  first: number | null;
  perChapter: Record<string, number>;
  paragraphs: Record<string, number[]>;
  coPresence: Record<string, number[]>;
  stale: string[];
};

/** Присутствие по `CHAPTERS_EN`: абзацы — индексы `paragraphsOf`, соседи — все герои версии. */
const MENTIONS_EN: Record<string, Mentions> = {
  'anna-lark': {
    chapters: [1, 2, 3],
    first: 1,
    perChapter: { '1': 2, '2': 1, '3': 1 },
    paragraphs: { '1': [0, 2], '2': [1], '3': [1] },
    coPresence: {
      'tom-reed': [1, 2, 3],
      'mira-vale': [2],
      'ned-fox': [3],
      'sam-holt': [2],
      'lou-grey': [1],
    },
    stale: [],
  },
  'tom-reed': {
    chapters: [1, 2, 3],
    first: 1,
    perChapter: { '1': 1, '2': 1, '3': 1 },
    paragraphs: { '1': [1], '2': [1], '3': [0] },
    coPresence: {
      'anna-lark': [1, 2, 3],
      'mira-vale': [2],
      'ned-fox': [3],
      'sam-holt': [2],
      'lou-grey': [1],
    },
    stale: [],
  },
  'mira-vale': {
    chapters: [2],
    first: 2,
    perChapter: { '2': 1 },
    paragraphs: { '2': [2] },
    coPresence: { 'anna-lark': [2], 'tom-reed': [2], 'sam-holt': [2] },
    stale: [],
  },
  'ned-fox': {
    chapters: [3],
    first: 3,
    perChapter: { '3': 1 },
    paragraphs: { '3': [2] },
    coPresence: { 'anna-lark': [3], 'tom-reed': [3] },
    stale: [],
  },
  'sam-holt': {
    chapters: [2],
    first: 2,
    perChapter: { '2': 1 },
    paragraphs: { '2': [3] },
    coPresence: { 'anna-lark': [2], 'tom-reed': [2], 'mira-vale': [2] },
    stale: [],
  },
  'lou-grey': {
    chapters: [1],
    first: 1,
    perChapter: { '1': 1 },
    paragraphs: { '1': [3] },
    coPresence: { 'anna-lark': [1], 'tom-reed': [1] },
    stale: [],
  },
};

const MENTIONS_RU_ANNA: Mentions = {
  chapters: [1, 2, 3],
  first: 1,
  perChapter: { '1': 1, '2': 1, '3': 1 },
  paragraphs: { '1': [0], '2': [0], '3': [0] },
  coPresence: {},
  stale: [],
};

/** Ядро героя (`world-core.ts`): «Коротко», характер, путь, 3 цитаты дословно, 2 сцены. */
const coreBlocks = (quotes: [number, string][], scenes: [number, string][]) => ({
  character: 'Steady and curious; keeps her word.',
  arc: { from: 'A mapmaker at home', to: 'A guide across the river' },
  quotes: quotes.map(([chapter, text]) => ({ text, chapter, interpretation: 'What it shows.' })),
  scenes: scenes.map(([chapter, title]) => ({
    chapter,
    title,
    text: `${title} in chapter ${chapter}.`,
  })),
});

const QUOTES_EN: [number, string][] = [
  [1, 'Anna Lark opened the old map at dawn.'],
  [2, 'Anna Lark and Tom Reed crossed the bridge together.'],
  [3, 'Anna Lark closed the map for the last time.'],
];
const SCENES_EN: [number, string][] = [
  [1, 'The map'],
  [2, 'The bridge'],
];

type EntitySeed = {
  key: string;
  name: string;
  short: string | null;
  blocks: Record<string, unknown>;
  mentions: Mentions;
  hasCore: boolean;
  coreMissing: string[];
  isListed: boolean;
  isVisible?: boolean;
  isIndexable?: boolean;
  /** Текст модели прочитан (`readAt ≥ autoTextAt`); `false` — текст модели без отметки. */
  read?: boolean;
  /** Источники внешних блоков: без них импорт отбивает `critique`, `prototypes`, `adaptations`. */
  sources?: { title: string; url: string }[];
};

/** Время текста модели и отметки «прочитано» — постоянное: повторный прогон сида ничего не сдвигает. */
const AUTO_TEXT_AT = new Date('2026-11-01T10:00:00.000Z');
const READ_AT = new Date('2026-11-01T11:00:00.000Z');

const ENTITIES_EN: EntitySeed[] = [
  {
    key: 'anna-lark',
    name: 'Anna Lark',
    short: 'A young mapmaker who leads the crossing.',
    blocks: {
      ...coreBlocks(QUOTES_EN, SCENES_EN),
      profile: { position: 'Mapmaker', relationToMain: 'The main heroine' },
      appearance: 'Tall, with ink on her fingers.',
      arc: {
        from: 'A mapmaker at home',
        to: 'A guide across the river',
        stages: [
          { title: 'The map', text: 'She reads the signs of the flood.', chapter: 1 },
          { title: 'The bridge', text: 'She leads the crossing.', chapter: 2 },
          { title: 'The end', text: 'She closes the map.', chapter: 3 },
        ],
      },
      // «Полный» герой — все блоки страницы героя (`product.md` §5): кто говорит в цитате, абзац
      // сцены, экранизации и внешние блоки с источниками.
      quotes: QUOTES_EN.map(([chapter, text], i) => ({
        text,
        chapter,
        interpretation: 'What it shows.',
        ...(i === 1 ? { speakerKey: 'tom-reed' } : {}),
      })),
      scenes: SCENES_EN.map(([chapter, title]) => ({
        chapter,
        title,
        text: `${title} in chapter ${chapter}.`,
        paragraph: 0,
      })),
      relations: [{ to: 'tom-reed', label: 'Friend and fellow traveller' }],
      adaptations: [
        {
          title: 'World Acceptance (service film)',
          year: 2001,
          actor: 'Service Actor',
          differences: 'Service text: the crossing happens at night.',
        },
      ],
      critique: 'Service text: critics read her as a figure of foresight.',
      prototypes: 'Service text: no known prototype.',
      faq: [{ question: 'Who is Anna Lark?', answer: 'The mapmaker who leads the crossing.' }],
    },
    sources: [{ title: 'Service source', url: 'https://example.com/world-acceptance' }],
    mentions: MENTIONS_EN['anna-lark'],
    hasCore: true,
    coreMissing: [],
    isListed: true,
  },
  {
    key: 'tom-reed',
    name: 'Tom Reed',
    short: 'A lamplighter who follows Anna.',
    blocks: coreBlocks(
      [
        [1, 'Tom Reed watched from the door.'],
        [2, 'Anna Lark and Tom Reed crossed the bridge together.'],
        [3, 'Tom Reed lit the lamp in the tower.'],
      ],
      [
        [1, 'The door'],
        [3, 'The lamp'],
      ],
    ),
    mentions: MENTIONS_EN['tom-reed'],
    hasCore: true,
    coreMissing: [],
    isListed: true,
  },
  {
    key: 'mira-vale',
    name: 'Mira Vale',
    short: 'She waits on the far bank.',
    blocks: coreBlocks(
      [
        [2, 'Mira Vale waited on the far bank.'],
        [2, 'The river rose before noon.'],
        [1, 'Anna Lark said the river would rise.'],
      ],
      [
        [2, 'The bank'],
        [2, 'The flood'],
      ],
    ),
    mentions: MENTIONS_EN['mira-vale'],
    hasCore: true,
    coreMissing: [],
    isListed: true,
    isIndexable: false,
  },
  {
    key: 'ned-fox',
    name: 'Ned Fox',
    short: 'The keeper of the keys.',
    blocks: coreBlocks(
      [
        [3, 'Ned Fox kept the keys.'],
        [3, 'Tom Reed lit the lamp in the tower.'],
        [1, 'Tom Reed watched from the door.'],
      ],
      [
        [3, 'The keys'],
        [3, 'The tower'],
      ],
    ),
    mentions: MENTIONS_EN['ned-fox'],
    hasCore: true,
    coreMissing: [],
    isListed: false,
    isVisible: false,
  },
  {
    key: 'sam-holt',
    name: 'Sam Holt',
    short: 'He counts the boats.',
    blocks: coreBlocks(
      [
        [2, 'Sam Holt counted the boats.'],
        [2, 'The river rose before noon.'],
        [1, 'Tom Reed watched from the door.'],
      ],
      [
        [2, 'The boats'],
        [2, 'The noon'],
      ],
    ),
    mentions: MENTIONS_EN['sam-holt'],
    hasCore: true,
    coreMissing: [],
    isListed: false,
    read: false,
  },
  {
    key: 'lou-grey',
    name: 'Lou Grey',
    short: 'She sings in the yard.',
    blocks: {
      character: 'Cheerful.',
      arc: { from: 'A singer', to: 'A singer' },
    },
    mentions: MENTIONS_EN['lou-grey'],
    hasCore: false,
    coreMissing: ['quotes', 'scenes'],
    isListed: false,
  },
];

const ENTITIES_RU: EntitySeed[] = [
  {
    key: 'anna-lark',
    name: 'Анна Ларк',
    short: 'Молодая картографка, которая ведёт переправу.',
    blocks: {
      character: 'Спокойная и любопытная.',
      arc: { from: 'Картографка дома', to: 'Проводница через реку' },
      quotes: [
        {
          text: 'Анна Ларк открыла старую карту на рассвете.',
          chapter: 1,
          interpretation: 'Начало.',
        },
        { text: 'Анна Ларк перешла мост до полудня.', chapter: 2, interpretation: 'Переправа.' },
        { text: 'Анна Ларк закрыла карту в последний раз.', chapter: 3, interpretation: 'Конец.' },
      ],
      scenes: [
        { chapter: 1, title: 'Карта', text: 'Она читает знаки паводка.' },
        { chapter: 2, title: 'Мост', text: 'Она ведёт переправу.' },
      ],
    },
    mentions: MENTIONS_RU_ANNA,
    hasCore: true,
    coreMissing: [],
    isListed: true,
  },
];

/** Книга мира с `noindex`: одна страница героя, тот же текст, что у `en` основной книги. */
const ENTITIES_NOINDEX: EntitySeed[] = [
  {
    ...ENTITIES_EN[0],
    mentions: {
      ...MENTIONS_EN['anna-lark'],
      coPresence: {},
    },
    blocks: {
      ...ENTITIES_EN[0].blocks,
      relations: null,
      // В книге с `noindex` одна сущность: «кто говорит» ссылался бы на героя, которого в версии нет.
      quotes: QUOTES_EN.map(([chapter, text]) => ({
        text,
        chapter,
        interpretation: 'What it shows.',
      })),
    },
  },
];

/**
 * Книга, где сущности мира есть, но ни одна не публична (`isVisible=false`): `/wiki` — 404, кнопки
 * «Мир книги» нет (`product.md` §4, §19 п.6).
 */
const ENTITIES_HIDDEN: EntitySeed[] = [
  {
    ...ENTITIES_EN[0],
    mentions: { ...MENTIONS_EN['anna-lark'], coPresence: {} },
    blocks: ENTITIES_NOINDEX[0].blocks,
    isListed: false,
    isVisible: false,
  },
];

type WorldSeedVersion = {
  language: Language;
  chapters: Record<number, string[]>;
  entities: EntitySeed[];
  /** Номера аудиоглав: «Слушать» у сцены есть только при аудиоглаве того же номера (Q6). */
  audioChapters?: number[];
};

/** Набор приёмки: книга, её версии, `noindex` книги. Его же читает `test/seed-dataset.e2e-spec.ts`. */
export function worldAcceptanceBooks(): {
  slug: string;
  noindex: boolean;
  versions: WorldSeedVersion[];
}[] {
  return [
    {
      slug: WORLD_ACCEPTANCE.book,
      noindex: false,
      versions: [
        // Аудио только у главы 1: сцена главы 1 — со «Слушать», главы 2 — без (решение арбитра Q6).
        { language: Language.en, chapters: CHAPTERS_EN, entities: ENTITIES_EN, audioChapters: [1] },
        { language: Language.ru, chapters: CHAPTERS_RU, entities: ENTITIES_RU },
      ],
    },
    {
      slug: WORLD_ACCEPTANCE.noindex,
      noindex: true,
      versions: [{ language: Language.en, chapters: CHAPTERS_EN, entities: ENTITIES_NOINDEX }],
    },
    {
      slug: WORLD_ACCEPTANCE.hidden,
      noindex: false,
      versions: [{ language: Language.en, chapters: CHAPTERS_EN, entities: ENTITIES_HIDDEN }],
    },
  ];
}

const json = (value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull =>
  value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);

function entityData(e: EntitySeed) {
  const read = e.read ?? true;
  return {
    type: 'character' as const,
    name: e.name,
    role: 'main',
    short: e.short,
    aliases: Prisma.DbNull,
    aliasExclusions: Prisma.DbNull,
    blocks: json(e.blocks),
    sources: json(e.sources ?? null),
    mentions: json(e.mentions),
    mentionsAt: AUTO_TEXT_AT,
    mentionChapters: e.mentions.chapters.length,
    mentionFirst: e.mentions.first,
    hasCore: e.hasCore,
    coreMissing: e.coreMissing,
    isListed: e.isListed,
    isVisible: e.isVisible ?? true,
    isIndexable: e.isIndexable ?? true,
    autoTextAt: AUTO_TEXT_AT,
    readAt: read ? READ_AT : null,
    firstPublishedAt: e.isListed ? READ_AT : null,
  };
}

export async function seedWorldAcceptance(
  prisma: PrismaClient,
  ensureRights: EnsureRights,
): Promise<void> {
  for (const bookSeed of worldAcceptanceBooks()) {
    const rights = await upsertAcceptanceBook(prisma, ensureRights, bookSeed.slug, {
      title: 'World Acceptance',
      summaryRu: 'Служебная книга приёмки мира книги',
    });
    await prisma.$transaction(
      async (tx) => {
        await pruneAcceptanceVersions(
          tx,
          rights.bookId,
          bookSeed.versions.map((v) => v.language),
        );
        for (const seedVersion of bookSeed.versions) {
          const words = wordsOf(seedVersion.language);
          const version = await upsertAcceptanceVersion(tx, rights, {
            slug: bookSeed.slug,
            language: seedVersion.language,
            title: words.title,
            description: words.description,
          });
          await seedSeoRobots(tx, version, bookSeed.noindex);
          await upsertAcceptanceChapters(
            tx,
            version.id,
            Object.keys(seedVersion.chapters).map(Number),
            (number) => ({
              title: `${words.chapter} ${number}`,
              content: html(seedVersion.chapters[number]),
            }),
          );
          const audio = seedVersion.audioChapters ?? [];
          await tx.audioChapter.deleteMany({
            where: { bookVersionId: version.id, number: { notIn: audio } },
          });
          for (const number of audio) {
            const chapter = {
              title: `${words.chapter} ${number}`,
              audioUrl: `https://example.com/world-acceptance/${seedVersion.language}/${number}.mp3`,
              duration: 60,
            };
            await tx.audioChapter.upsert({
              where: { bookVersionId_number: { bookVersionId: version.id, number } },
              update: chapter,
              create: { ...chapter, bookVersionId: version.id, number },
              select: { id: true },
            });
          }
          // Набор — вся правда о мире версии: сущности вне набора снимаются, очередь пересчёта
          // пуста (литералы уже равны подсчёту).
          await tx.bookWorldEntity.deleteMany({
            where: {
              bookVersionId: version.id,
              key: { notIn: seedVersion.entities.map((e) => e.key) },
            },
          });
          await tx.worldMentionsPending.deleteMany({ where: { bookVersionId: version.id } });
          for (const e of seedVersion.entities) {
            const data = entityData(e);
            await tx.bookWorldEntity.upsert({
              where: { bookVersionId_key: { bookVersionId: version.id, key: e.key } },
              update: { ...data, updatedAt: READ_AT },
              create: { ...data, bookVersionId: version.id, key: e.key, updatedAt: READ_AT },
              select: { id: true },
            });
          }
        }
      },
      { timeout: 60_000, maxWait: 15_000 },
    );
  }
}

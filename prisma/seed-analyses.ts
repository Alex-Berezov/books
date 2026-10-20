import { Language, Prisma, type PrismaClient } from '@prisma/client';
import {
  type EnsureRights,
  pruneAcceptanceVersions,
  upsertAcceptanceBook,
  upsertAcceptanceChapters,
  upsertAcceptanceVersion,
} from './seed-acceptance';

/**
 * Анализы для приёмки раздела «Разбор и анализ» (`F03-4`, `books-front/e2e/book-analysis.spec.ts`,
 * `books-app-docs/features/F03-book-analysis/product.md` §24).
 *
 * Книги здесь служебные и названы так, чтобы это было видно (решение арбитра `F03 | F03-4`, В1):
 * текст глав и анализа - служебный, цитаты взяты дословно из глав, которые заводит этот же сид.
 * Эталоны `prompts/` сюда не копируются: цитаты es/fr/pt в них не сверены с изданием,
 * а копий эталона ровно три (решение А7). Книги вне `SEO_CATALOG_BOOKS` - точные числа
 * каталога в `test/seed-dataset.e2e-spec.ts` от них не меняются.
 *
 * - `full` - полный анализ на пяти языках, главы 1-4; гео-правило читалки `en` для `GB`
 *   (анализ при этом открыт, D7);
 * - `minimal` - только ядро (`en`);
 * - `no-core` - анализ без ядра: на `en` одна тема из двух, на `ru` нет главной мысли;
 *   у обеих версий есть пересказ, чтобы проверить отсутствие кнопки и на странице пересказа;
 * - `two-langs` - версии `en`, `es`, `fr`, анализ только на `en` и `fr`;
 * - `no-chapters` - версия без глав, а в анализе ссылки на главы.
 *
 * `hasCore` записан литералом: функция ядра живёт в `src/`, а `src/` в образе сиду недоступен.
 * Сверку литерала с `computeAnalysisCore` и формы с DTO (`PUT ?dryRun=true`) держит
 * `test/seed-dataset.e2e-spec.ts`.
 */

type Blocks = Partial<Record<AnalysisField, unknown>>;

/**
 * Поля анализа, которые пишет импорт. Отсутствующее в записи сида пишется пустым. Копия
 * `BOOK_ANALYSIS_BLOCK_KEYS` (`src/` сиду в образе недоступен): состав и деление на текст и Json
 * сверяет `test/seed-dataset.e2e-spec.ts` - меняешь блоки анализа, меняй и здесь.
 */
export const ANALYSIS_FIELDS = [
  'facts',
  'mainIdea',
  'themes',
  'characters',
  'symbols',
  'keyQuotes',
  'titleMeaning',
  'endingMeaning',
  'context',
  'timeline',
  'style',
  'reception',
  'adaptations',
  'misreadings',
  'discussionQuestions',
  'faq',
  'sources',
] as const;
type AnalysisField = (typeof ANALYSIS_FIELDS)[number];
export const ANALYSIS_TEXT_FIELDS = new Set<AnalysisField>([
  'mainIdea',
  'titleMeaning',
  'endingMeaning',
  'context',
  'reception',
]);

/** Слаги книг приёмки: один слаг на все языки версии (слаг уникален в пределах языка). */
export const ANALYSIS_ACCEPTANCE = {
  full: 'analysis-acceptance-full',
  minimal: 'analysis-acceptance-minimal',
  noCore: 'analysis-acceptance-no-core',
  twoLangs: 'analysis-acceptance-two-langs',
  noChapters: 'analysis-acceptance-no-chapters',
} as const;

/** Страна, где читалка `en` полной книги закрыта гео-правилом (анализ открыт, D7). */
export const ANALYSIS_ACCEPTANCE_GEO_COUNTRY = 'GB';

/** Служебные строки на язык. Цитаты `quotes` дословно лежат в главах 1-3. */
interface Words {
  title: string;
  service: string;
  chapter: string;
  quotes: [string, string, string];
  theme: [string, string, string];
  hero: [string, string, string, string, string];
  label: [string, string, string, string];
  symbol: [string, string];
  device: [string, string];
  adaptation: [string, string, string];
  question: [string, string, string];
  faq: [string, string];
  myth: [string, string];
  event: [string, string, string];
}

const WORDS: Record<Language, Words> = {
  en: {
    title: 'Analysis acceptance book',
    service: 'Service text of the acceptance analysis.',
    chapter: 'Chapter',
    quotes: [
      'The lamp in the window stayed lit all night.',
      'Nobody on the road asked where we were going.',
      'Silence is also an answer, said the keeper.',
    ],
    theme: ['Memory', 'The road', 'Silence'],
    hero: ['Anna Keeper', 'Boris Walker', 'Vera Lamp', 'Gleb Bridge', 'Dmitry Post'],
    label: ['friend of', 'sister of', 'rival of', 'teacher of'],
    symbol: ['The lamp', 'The bridge'],
    device: ['Repetition', 'Open ending'],
    adaptation: ['Acceptance film', 'Acceptance series', 'Acceptance reading'],
    question: [
      'Why does the lamp stay lit?',
      'What does the road change in Anna?',
      'Is silence an answer here?',
    ],
    faq: ['What is the acceptance book about?', 'Who is the main character?'],
    myth: ['The book is about a journey', 'The keeper is the narrator'],
    event: [
      'The acceptance author is born.',
      'The era of the acceptance book.',
      'The book is written.',
    ],
  },
  es: {
    title: 'Libro de aceptación del análisis',
    service: 'Texto de servicio del análisis de aceptación.',
    chapter: 'Capítulo',
    quotes: [
      'La lámpara de la ventana estuvo encendida toda la noche.',
      'Nadie en el camino preguntó adónde íbamos.',
      'El silencio también es una respuesta, dijo el guardián.',
    ],
    theme: ['La memoria', 'El camino', 'El silencio'],
    hero: ['Ana Guardiana', 'Boris Caminante', 'Vera Lámpara', 'Gleb Puente', 'Dmitri Correo'],
    label: ['amiga de', 'hermana de', 'rival de', 'maestra de'],
    symbol: ['La lámpara', 'El puente'],
    device: ['Repetición', 'Final abierto'],
    adaptation: ['Película de aceptación', 'Serie de aceptación', 'Lectura de aceptación'],
    question: [
      '¿Por qué sigue encendida la lámpara?',
      '¿Qué cambia el camino en Ana?',
      '¿Es aquí el silencio una respuesta?',
    ],
    faq: ['¿De qué trata el libro de aceptación?', '¿Quién es la protagonista?'],
    myth: ['El libro trata de un viaje', 'El guardián es el narrador'],
    event: [
      'Nace el autor de aceptación.',
      'La época del libro de aceptación.',
      'Se escribe el libro.',
    ],
  },
  fr: {
    title: 'Livre de recette de l’analyse',
    service: 'Texte de service de l’analyse de recette.',
    chapter: 'Chapitre',
    quotes: [
      'La lampe à la fenêtre resta allumée toute la nuit.',
      'Personne sur la route ne demanda où nous allions.',
      'Le silence est aussi une réponse, dit le gardien.',
    ],
    theme: ['La mémoire', 'La route', 'Le silence'],
    hero: ['Anna Gardienne', 'Boris Marcheur', 'Vera Lampe', 'Gleb Pont', 'Dmitri Poste'],
    label: ['amie de', 'sœur de', 'rivale de', 'maîtresse de'],
    symbol: ['La lampe', 'Le pont'],
    device: ['Répétition', 'Fin ouverte'],
    adaptation: ['Film de recette', 'Série de recette', 'Lecture de recette'],
    question: [
      'Pourquoi la lampe reste-t-elle allumée ?',
      'Que change la route chez Anna ?',
      'Le silence est-il ici une réponse ?',
    ],
    faq: ['De quoi parle le livre de recette ?', 'Qui est le personnage principal ?'],
    myth: ['Le livre raconte un voyage', 'Le gardien est le narrateur'],
    event: [
      'Naissance de l’auteur de recette.',
      'L’époque du livre de recette.',
      'Le livre est écrit.',
    ],
  },
  pt: {
    title: 'Livro de aceitação da análise',
    service: 'Texto de serviço da análise de aceitação.',
    chapter: 'Capítulo',
    quotes: [
      'A lâmpada da janela ficou acesa a noite toda.',
      'Ninguém na estrada perguntou para onde íamos.',
      'O silêncio também é uma resposta, disse o guardião.',
    ],
    theme: ['A memória', 'A estrada', 'O silêncio'],
    hero: ['Ana Guardiã', 'Boris Andarilho', 'Vera Lâmpada', 'Gleb Ponte', 'Dmitri Correio'],
    label: ['amiga de', 'irmã de', 'rival de', 'mestra de'],
    symbol: ['A lâmpada', 'A ponte'],
    device: ['Repetição', 'Final aberto'],
    adaptation: ['Filme de aceitação', 'Série de aceitação', 'Leitura de aceitação'],
    question: [
      'Por que a lâmpada continua acesa?',
      'O que a estrada muda em Ana?',
      'O silêncio é aqui uma resposta?',
    ],
    faq: ['Sobre o que é o livro de aceitação?', 'Quem é a protagonista?'],
    myth: ['O livro é sobre uma viagem', 'O guardião é o narrador'],
    event: ['Nasce o autor de aceitação.', 'A época do livro de aceitação.', 'O livro é escrito.'],
  },
  ru: {
    title: 'Книга приёмки анализа',
    service: 'Служебный текст анализа приёмки.',
    chapter: 'Глава',
    quotes: [
      'Лампа в окне горела всю ночь.',
      'Никто на дороге не спросил, куда мы идём.',
      'Молчание - тоже ответ, сказал смотритель.',
    ],
    theme: ['Память', 'Дорога', 'Молчание'],
    hero: ['Анна Смотрова', 'Борис Ходоков', 'Вера Лампова', 'Глеб Мостов', 'Дмитрий Почтов'],
    label: ['подруга', 'сестра', 'соперник', 'учитель'],
    symbol: ['Лампа', 'Мост'],
    device: ['Повтор', 'Открытый финал'],
    adaptation: ['Фильм приёмки', 'Сериал приёмки', 'Чтение приёмки'],
    question: ['Почему лампа не гаснет?', 'Что дорога меняет в Анне?', 'Молчание здесь - ответ?'],
    faq: ['О чём книга приёмки?', 'Кто главная героиня?'],
    myth: ['Книга о путешествии', 'Смотритель - рассказчик'],
    event: ['Рождается автор приёмки.', 'Эпоха книги приёмки.', 'Книга написана.'],
  },
};

const THEME_KEYS = ['memory', 'road', 'silence'] as const;
const HERO_KEYS = ['anna', 'boris', 'vera', 'gleb', 'dmitry'] as const;

const text = (words: Words, what: string) => `${words.service} ${what}`;

/** Ядро: главная мысль, две темы, два героя, три цитаты (`BOOK_ANALYSIS_CORE`). */
function core(words: Words): Blocks {
  return {
    mainIdea: text(words, words.title),
    themes: [0, 1].map((i) => ({
      key: THEME_KEYS[i],
      title: words.theme[i],
      interpretation: text(words, words.theme[i]),
      chapters: [i + 1],
    })),
    characters: [0, 1].map((i) => ({
      key: HERO_KEYS[i],
      name: words.hero[i],
      role: 'main',
      description: text(words, words.hero[i]),
    })),
    keyQuotes: [0, 1, 2].map((i) => ({
      text: words.quotes[i],
      chapter: i + 1,
      interpretation: text(words, words.quotes[i]),
    })),
  };
}

/** Все семнадцать блоков §4-§20. */
function full(words: Words): Blocks {
  const roles = ['main', 'main', 'secondary', 'secondary', 'minor'] as const;
  return {
    facts: {
      genre: text(words, '§4.1'),
      movement: text(words, '§4.2'),
      writtenYears: '2026',
      settingPlace: text(words, '§4.4'),
      settingTime: text(words, '§4.5'),
      narrator: text(words, '§4.6'),
      structure: text(words, '§4.7'),
    },
    mainIdea: text(words, words.title),
    themes: THEME_KEYS.map((key, i) => ({
      key,
      title: words.theme[i],
      interpretation: text(words, words.theme[i]),
      chapters: i === 0 ? [1, 3, 4] : [i + 1],
      quotes: [{ text: words.quotes[i], chapter: i + 1, comment: text(words, words.theme[i]) }],
    })),
    characters: HERO_KEYS.map((key, i) => ({
      key,
      name: words.hero[i],
      role: roles[i],
      description: text(words, words.hero[i]),
      ...(i === 0 ? { arc: { from: text(words, '§7.1'), to: text(words, '§7.2') } } : {}),
      themeKeys: [THEME_KEYS[i % THEME_KEYS.length]],
      // Связи только между нарисованными узлами карты (main + secondary); у `dmitry` (minor)
      // связь есть, но в карту он не попадает - и связь вместе с ним.
      relations:
        i === 0
          ? [
              { to: 'boris', label: words.label[0] },
              { to: 'vera', label: words.label[1] },
            ]
          : i === 1
            ? [{ to: 'gleb', label: words.label[2] }]
            : i === 4
              ? [{ to: 'anna', label: words.label[3] }]
              : [],
    })),
    symbols: words.symbol.map((title, i) => ({
      title,
      interpretation: text(words, title),
      chapters: [i + 2],
    })),
    keyQuotes: words.quotes.map((quote, i) => ({
      text: quote,
      chapter: i + 1,
      speakerKey: HERO_KEYS[i],
      themeKeys: [THEME_KEYS[i]],
      interpretation: text(words, quote),
    })),
    titleMeaning: text(words, '§12.1'),
    endingMeaning: text(words, '§12.2'),
    context: text(words, '§13'),
    timeline: (['author', 'epoch', 'book'] as const).map((kind, i) => ({
      year: String(2000 + i * 10),
      event: words.event[i],
      kind,
    })),
    style: words.device.map((device, i) => ({
      device,
      explanation: text(words, device),
      ...(i === 0 ? { example: { text: words.quotes[0], chapter: 1 } } : {}),
    })),
    reception: text(words, '§15'),
    adaptations: (['film', 'series', 'other'] as const).map((kind, i) => ({
      title: words.adaptation[i],
      year: 2020 + i,
      kind,
      differences: text(words, words.adaptation[i]),
    })),
    misreadings: words.myth.map((myth) => ({ myth, explanation: text(words, myth) })),
    discussionQuestions: [...words.question],
    faq: words.faq.map((question) => ({ question, answer: text(words, question) })),
    sources: [{ title: text(words, '§20'), url: 'https://example.com/analysis-acceptance' }],
  };
}

interface AcceptanceVersion {
  language: Language;
  /** Номера глав версии; пусто - версия без глав. */
  chapters: number[];
  analysis?: { blocks: Blocks; hasCore: boolean };
  /** Пересказ с видимым текстом. */
  summary?: boolean;
}

interface AcceptanceBook {
  slug: string;
  versions: AcceptanceVersion[];
}

const ALL_LANGS = Object.values(Language);

/** Набор приёмки. Экспортирован для сверки в `test/seed-dataset.e2e-spec.ts`. */
export function analysisAcceptanceBooks(): AcceptanceBook[] {
  const en = WORDS.en;
  return [
    {
      slug: ANALYSIS_ACCEPTANCE.full,
      versions: ALL_LANGS.map((language) => ({
        language,
        chapters: [1, 2, 3, 4],
        analysis: { blocks: full(WORDS[language]), hasCore: true },
      })),
    },
    {
      slug: ANALYSIS_ACCEPTANCE.minimal,
      versions: [
        {
          language: Language.en,
          chapters: [1, 2, 3],
          analysis: { blocks: core(en), hasCore: true },
        },
      ],
    },
    {
      slug: ANALYSIS_ACCEPTANCE.noCore,
      versions: [
        {
          language: Language.en,
          chapters: [1, 2, 3],
          // Одна тема из двух нужных.
          analysis: {
            blocks: { ...core(en), themes: (core(en).themes as unknown[]).slice(0, 1) },
            hasCore: false,
          },
          summary: true,
        },
        {
          language: Language.ru,
          chapters: [1, 2, 3],
          // Без главной мысли. Строку из пробелов сюда не пишем: импорт обрезает её до пустой,
          // в базе такой строки не бывает (обрезку держат юниты ядра и DTO).
          analysis: {
            blocks: Object.fromEntries(
              Object.entries(core(WORDS.ru)).filter(([field]) => field !== 'mainIdea'),
            ),
            hasCore: false,
          },
          summary: true,
        },
      ],
    },
    {
      slug: ANALYSIS_ACCEPTANCE.twoLangs,
      versions: [Language.en, Language.es, Language.fr].map((language) => ({
        language,
        chapters: [1, 2, 3],
        ...(language === Language.es
          ? {}
          : { analysis: { blocks: core(WORDS[language]), hasCore: true } }),
      })),
    },
    {
      slug: ANALYSIS_ACCEPTANCE.noChapters,
      versions: [
        { language: Language.en, chapters: [], analysis: { blocks: full(en), hasCore: true } },
      ],
    },
  ];
}

/** Запись анализа целиком: поле, которого нет в наборе, пишется пустым поверх ручного импорта. */
function analysisData(blocks: Blocks, hasCore: boolean) {
  const data: Record<string, unknown> = { hasCore };
  for (const field of ANALYSIS_FIELDS) {
    const value = blocks[field];
    if (ANALYSIS_TEXT_FIELDS.has(field)) data[field] = typeof value === 'string' ? value : null;
    else data[field] = value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);
  }
  return data as Omit<Prisma.BookAnalysisUncheckedCreateInput, 'bookVersionId'>;
}

function chapterContent(words: Words, number: number): string {
  const quote = number <= words.quotes.length ? `<p>${words.quotes[number - 1]}</p>` : '';
  return `<p>${words.service} ${words.chapter} ${number}.</p>${quote}`;
}

/**
 * Заводит книги приёмки анализа. Идемпотентно: книга по слагу, версия по `(bookId, language)`,
 * главы по `(bookVersionId, number)`, анализ и пересказ по `bookVersionId` с полным набором полей,
 * гео-правило по `(bookVersionId, scope, countryCode)`.
 */
export async function seedAnalysisAcceptance(
  prisma: PrismaClient,
  ensureRights: EnsureRights,
): Promise<void> {
  for (const bookSeed of analysisAcceptanceBooks()) {
    const rights = await upsertAcceptanceBook(prisma, ensureRights, bookSeed.slug, {
      title: WORDS.en.title,
      summaryRu: 'Служебная книга приёмки анализа',
    });

    await prisma.$transaction(
      async (tx) => {
        // Версия книги приёмки на языке вне набора снимается вместе со своими строками (каскад).
        await pruneAcceptanceVersions(
          tx,
          rights.bookId,
          bookSeed.versions.map((seedVersion) => seedVersion.language),
        );
        // Правило на всю книгу (без версии) проверка доступа находит по `bookId`: в наборе таких нет.
        await tx.geoBlockRule.deleteMany({ where: { bookId: rights.bookId, bookVersionId: null } });

        for (const seedVersion of bookSeed.versions) {
          const words = WORDS[seedVersion.language];
          // Гео-правило ниже - приёмочная фикстура читалки, а не итог клиренса: снимок прав версии
          // тот же, что у каталога (`seed.ts`), его читает клиренс, и сид его не трогает.
          const geoBlocked =
            bookSeed.slug === ANALYSIS_ACCEPTANCE.full && seedVersion.language === Language.en;
          const { id: versionId } = await upsertAcceptanceVersion(tx, rights, {
            slug: bookSeed.slug,
            language: seedVersion.language,
            title: words.title,
            description: words.service,
          });

          // Набор - вся правда о версии приёмки: строки, ушедшие из набора, снимаются той же
          // транзакцией. Удаление только по версиям книг приёмки - чужих строк здесь нет.
          if (!seedVersion.analysis) {
            await tx.bookAnalysis.deleteMany({ where: { bookVersionId: versionId } });
          }
          if (!seedVersion.summary) {
            await tx.bookSummary.deleteMany({ where: { bookVersionId: versionId } });
          }
          await tx.geoBlockRule.deleteMany({
            where: {
              bookVersionId: versionId,
              ...(geoBlocked
                ? {
                    NOT: { scope: 'TEXT_READER', countryCode: ANALYSIS_ACCEPTANCE_GEO_COUNTRY },
                  }
                : {}),
            },
          });

          await upsertAcceptanceChapters(tx, versionId, seedVersion.chapters, (number) => ({
            title: `${words.chapter} ${number}`,
            content: chapterContent(words, number),
          }));

          if (seedVersion.analysis) {
            const data = analysisData(seedVersion.analysis.blocks, seedVersion.analysis.hasCore);
            await tx.bookAnalysis.upsert({
              where: { bookVersionId: versionId },
              update: data,
              create: { ...data, bookVersionId: versionId },
              select: { id: true },
            });
          }

          if (seedVersion.summary) {
            const summary = { summary: `<p>${words.service}</p>`, hasText: true };
            await tx.bookSummary.upsert({
              where: { bookVersionId: versionId },
              update: summary,
              create: { ...summary, bookVersionId: versionId },
              select: { id: true },
            });
          }

          if (geoBlocked) {
            const rule = {
              bookId: rights.bookId,
              accessPolicy: 'BLOCK' as const,
              sourceFinalStatus: 'BLOCKED' as const,
              isActive: true,
              generatedFrom: 'SEED_ACCEPTANCE',
              // Ручные правки правила сбрасываются к набору: фикстура не ведёт клиренс.
              rightsProfileId: null,
              territoryDecisionId: null,
              reasonRu: null,
              legalBasisRu: null,
              verifiedAt: null,
              verifiedByUserId: null,
              verificationNotesRu: null,
            };
            await tx.geoBlockRule.upsert({
              where: {
                bookVersionId_scope_countryCode: {
                  bookVersionId: versionId,
                  scope: 'TEXT_READER',
                  countryCode: ANALYSIS_ACCEPTANCE_GEO_COUNTRY,
                },
              },
              update: rule,
              create: {
                ...rule,
                bookVersionId: versionId,
                scope: 'TEXT_READER',
                countryCode: ANALYSIS_ACCEPTANCE_GEO_COUNTRY,
              },
              select: { id: true },
            });
          }
        }
      },
      { timeout: 60_000, maxWait: 15_000 },
    );
  }
}

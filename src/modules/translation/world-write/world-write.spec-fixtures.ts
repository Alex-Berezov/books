import type { PrismaService } from '../../../prisma/prisma.service';
import type { WorldMentionsService } from '../../book-world/world-mentions.service';
import type { LlmService } from '../../llm/llm.service';
import type { LlmTaskService } from '../../llm-worker/llm-task.service';
import type { SourceFetcherService } from '../../source-fetch/source-fetcher.service';
import type { ContentDraftService } from '../content-draft/content-draft.service';
import type { DossierDemandService } from '../dossier/dossier-demand.service';
import type { WorldWriteFields } from './world-write.fields';
import { WorldWriteHandler } from './world-write.handler';

/**
 * Общие подставки спек хода «Write World» (`F08-8e-5`, решение арбитра `F08 | F08-8e-5`): герой-кандидат
 * хода и контекст шага пары из двух глав - одна глава на героя, общих глав нет. Одни на спеки
 * обработчика и сервиса: копия расходилась бы с первой правкой формы кандидата или контекста.
 */
export const worldHero = (key: string, chapters: number[]) => ({
  key,
  role: 'main' as const,
  name: key.toUpperCase(),
  aliases: [] as string[],
  mentions: { chapters, perChapter: {} },
});

/** Контекст шага пары: Anna - в главе 1, Boris - в главе 2; `entities` - сущности мира версии. */
export const worldPairContext = (entities = new Map<string, { type: string }>()) => ({
  language: 'en',
  dossier: null,
  glossary: null,
  bookTitle: 'B',
  author: 'A',
  originalLanguage: '',
  entities,
  chapters: [
    { number: 1, title: 'C1', content: '<p>Anna maps the road.</p>' },
    { number: 2, title: 'C2', content: '<p>Boris rings the bell.</p>' },
  ],
  analysis: { characters: [] },
  names: { titles: ['B'], authors: ['A'] },
});

/** Зависимости обработчика хода по именам - порядок конструктора `WorldWriteHandler`. */
interface WorldWriteHandlerDeps {
  prisma: PrismaService;
  llm: LlmService;
  tasks: LlmTaskService;
  dossiers: DossierDemandService;
  drafts: ContentDraftService;
  fields: WorldWriteFields;
  fetcher: SourceFetcherService;
  mentions: WorldMentionsService;
}

/**
 * Обработчик хода для спек: подставки по имени зависимости, остальные - пустые объекты. Спека
 * передаёт подставку с нужными ей методами; приведение к типу зависимости - здесь одно, а не
 * восемь `{} as never` в каждом конструкторе (решение арбитра `F08 | F08-8e-5`).
 */
export function worldWriteHandler(
  deps: { [K in keyof WorldWriteHandlerDeps]?: object } = {},
): WorldWriteHandler {
  const dep = <K extends keyof WorldWriteHandlerDeps>(name: K) =>
    (deps[name] ?? {}) as WorldWriteHandlerDeps[K];
  return new WorldWriteHandler(
    dep('prisma'),
    dep('llm'),
    dep('tasks'),
    dep('dossiers'),
    dep('drafts'),
    dep('fields'),
    dep('fetcher'),
    dep('mentions'),
  );
}

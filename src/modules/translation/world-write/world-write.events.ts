import { Language } from '@prisma/client';
import { resolveOriginalLanguage } from '../original-language';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { StoredWorldEntity } from '../../book-world/book-world-data';
import {
  BOOK_WORLD_KEY_REGEX,
  BOOK_WORLD_LIMITS,
} from '../../book-world/dto/book-world-blocks.dto';
import { hasPairSeparator } from '../../book-world/world-refs';
import {
  activeChapterExclusions,
  mentionForms,
  type WorldMentionSource,
} from '../../book-world/world-mentions';
import { slugifyLocalized } from '../../seo/utils/slugifyLocalized';
import { hasWorldObjectExample } from './examples';
import type { WorldSelectEvent } from './world-write.checks';
import { WORLD_EVENT_KEY_MAX, WORLD_EVENTS_MAX } from './world-write.constants';
import {
  byKey,
  runTypeMode,
  selectByChapters,
  type WorldChapterRules,
  type WorldTypeMode,
} from './world-write.dossier-entities';
import type {
  WorldEventCandidate,
  WorldEventsOffReason,
  WorldSkip,
  WorldSkipReason,
} from './world-write.data';

/**
 * События хода «Write World» (`F08-13b-2`, решения арбитра `F08 | F08-13b` Q2-Q4, Q7, `F08 | F08-13`
 * Q5). В отличие от предмета и понятия событий нет в досье: кандидатов предлагает шаг выбора, а код
 * решает, что из этого ходу годится. Всё решение - здесь, чистыми функциями; присутствие по тексту
 * считает обработчик (`countedOf`), как у героев и сущностей досье.
 *
 * - ключ: сначала ключ события из мира других версий книги (исходник первым), который назвала
 *   модель, иначе латиница по названию на языке оригинала от выбора, а нет его - по названию версии
 *   (`latinEventKey`, решение `F08 | F08-13b` Q3-1); ключ один на все языки и навсегда (Q3);
 * - главы: формы названия в тексте ∪ главы из ответа выбора, главы вне версии код уже снял (Q4);
 * - потолок 10 на ход по убыванию глав, затем по ключу; без известной главы - отсечено (Q2).
 */

/** Событие другой версии книги: ключ и название - подсказка выбору и источник ключа (Q3). */
export interface KnownWorldEvent {
  key: string;
  name: string;
}

/** Событие шага выбора с ключом, проверенным кодом, до подсчёта присутствия. */
export interface WorldEventPick {
  key: string;
  name: string;
  aliases: string[];
  /** Главы из ответа выбора - только известные версии. */
  chapters: number[];
}

/** Правило отбора событий по главам (Q2): хотя бы одна глава, потолок `WORLD_EVENTS_MAX`. */
const EVENT_RULES: WorldChapterRules = {
  min: 1,
  max: WORLD_EVENTS_MAX,
  below: 'EVENT_NO_CHAPTER',
  over: 'EVENTS_MAX',
};

/**
 * Режим шага выбора событий (одно условие на промпт выбора и `eventChoice` обработчика) - то же
 * правило, что у сущностей досье (`runTypeMode`): `old` - ход, начатый до событий, их не получает -
 * его оценка их не включала; `language` - язык без эталона события; `on` - выбираются.
 */
export const eventsMode = (
  language: string,
  previous: WorldEventCandidate[] | null,
): WorldTypeMode => runTypeMode(previous, hasWorldObjectExample(language, 'event'));

/** Причина хода без событий: язык без эталона. */
export const EVENTS_OFF: WorldEventsOffReason = 'WORLD_EVENT_LANGUAGE';

/**
 * События мира других версий книги, исходник первым (`originalLanguage`), затем по языку и ключу;
 * одно событие на ключ. Вход - строки мира других версий (`key`, `name`, `language`).
 */
export function knownEventsOf(
  rows: ReadonlyArray<{ key: string; name: string; language: string }>,
  originalLanguage: string,
): KnownWorldEvent[] {
  const sorted = [...rows].sort(
    (a, b) =>
      Number(b.language === originalLanguage) - Number(a.language === originalLanguage) ||
      (a.language < b.language ? -1 : a.language > b.language ? 1 : 0) ||
      byKey(a, b),
  );
  const seen = new Set<string>();
  const out: KnownWorldEvent[] = [];
  for (const row of sorted) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    out.push({ key: row.key, name: row.name });
  }
  return out;
}

const KNOWN_EVENTS_MAX = BOOK_WORLD_LIMITS.entities;
const isSiteLanguage = (code: string): code is Language =>
  (Object.values(Language) as string[]).includes(code);

/** Версий книги не больше, чем языков сайта (`@@unique([bookId, language])`): строк ключа - не больше. */
const VERSIONS_MAX = Object.values(Language).length;

/**
 * Код языка оригинала из поля версии: поле - свободный текст («Russian», «ru», «русский»), его
 * сводит `resolveOriginalLanguage`; не распознано - пустая строка. Сравнивать с кодом языка версии
 * можно только его (Q3, Q3-1).
 */
export const originalLanguageCode = (raw: string | null | undefined): string => {
  const resolved = resolveOriginalLanguage(raw);
  return resolved.kind === 'unknown' ? '' : resolved.code;
};

/**
 * Известные события для подсказки ключа выбору (`KNOWN_EVENTS`) - один набор на шаг выбора хода
 * (`contextOf` обработчика с `withEvents`) и на оценку (`WorldWriteService.estimate`, Q9). Порядок и
 * общий предел `KNOWN_EVENTS_MAX` (решения `F08 | F08-13b` Q3, `F08 | F08-13b-2` Q3-2): сначала
 * сохранённые события этой версии - повторный ход сохраняет их ключи, затем версии на языке
 * оригинала, затем остальных версий по одному на ключ. Отдельные ключи остальных версий берутся
 * `groupBy` до среза: `distinct` Prisma применяет после `take`, и повторы одного ключа по версиям
 * съели бы предел (`LEGACY-254`).
 */
export async function knownWorldEvents(
  prisma: Pick<PrismaService, 'bookWorldEntity'>,
  bookVersionId: string,
  originalLanguage: string,
): Promise<KnownWorldEvent[]> {
  const sameBook = { book: { versions: { some: { id: bookVersionId } } } };
  const type = 'event' as const;
  const own = await prisma.bookWorldEntity.findMany({
    where: { type, bookVersionId },
    select: { key: true, name: true },
    orderBy: { key: 'asc' },
    take: KNOWN_EVENTS_MAX,
  });
  const code = originalLanguageCode(originalLanguage);
  const original = isSiteLanguage(code) ? code : null;
  const fromOriginal =
    original === null || own.length >= KNOWN_EVENTS_MAX
      ? []
      : await prisma.bookWorldEntity.findMany({
          where: {
            type,
            bookVersionId: { not: bookVersionId },
            key: { notIn: own.map((e) => e.key) },
            bookVersion: { ...sameBook, language: original },
          },
          select: { key: true, name: true },
          orderBy: { key: 'asc' },
          take: KNOWN_EVENTS_MAX - own.length,
        });
  const left = KNOWN_EVENTS_MAX - own.length - fromOriginal.length;
  const others = {
    type,
    bookVersionId: { not: bookVersionId },
    key: { notIn: [...own, ...fromOriginal].map((e) => e.key) },
    bookVersion: original === null ? sameBook : { ...sameBook, language: { not: original } },
  };
  const keys =
    left <= 0
      ? []
      : (
          await prisma.bookWorldEntity.groupBy({
            by: ['key'],
            where: others,
            orderBy: { key: 'asc' },
            take: left,
          })
        ).map((g) => g.key);
  const rows =
    keys.length === 0
      ? []
      : await prisma.bookWorldEntity.findMany({
          where: { ...others, key: { in: keys } },
          select: { key: true, name: true, bookVersion: { select: { language: true } } },
          orderBy: { key: 'asc' },
          take: keys.length * VERSIONS_MAX,
        });
  return [
    ...own,
    ...fromOriginal,
    ...knownEventsOf(
      rows.map((e) => ({ key: e.key, name: e.name, language: e.bookVersion.language })),
      code,
    ),
  ].map((e) => ({ key: e.key, name: e.name }));
}

/** Ключ событию годится как ключ мира: правило ключа и не вид пары (`hasPairSeparator`). */
const keyUsable = (key: string): boolean =>
  BOOK_WORLD_KEY_REGEX.test(key) && !hasPairSeparator(key);

/**
 * Латиница по названию (`F08 | F08-13b` Q3): `slugifyLocalized` сам не трогается - здесь обрезка до
 * 60 знаков без хвостового дефиса и проверка правила ключа; не собралась (название не из букв) - `null`.
 */
export function latinEventKey(name: string): string | null {
  const key = slugifyLocalized(name).slice(0, WORLD_EVENT_KEY_MAX).replace(/-+$/, '');
  return keyUsable(key) ? key : null;
}

/**
 * Ключ события: ключ, названный моделью, - если он есть в мире других версий (`known`); иначе латиница
 * по названию на языке оригинала (`originalName`, решение `F08 | F08-13b` Q3-1), а его нет, оно пусто
 * или не даёт ключа - по названию версии. Ключ модели, которого в других версиях нет, не принимается -
 * иначе модель придумывала бы ключи, которые не сходятся между языками. На версии-исходнике
 * `originalName` не берётся (`useOriginal`): название версии и есть название оригинала.
 */
export function eventKeyOf(
  pick: Pick<WorldSelectEvent, 'key' | 'name' | 'originalName'>,
  known: ReadonlySet<string>,
  useOriginal: boolean,
): string | null {
  if (known.has(pick.key) && keyUsable(pick.key)) return pick.key;
  const original = useOriginal && pick.originalName ? latinEventKey(pick.originalName) : null;
  return original ?? latinEventKey(pick.name);
}

const skip = (key: string, reason: WorldSkipReason, name: string, chapters: number | null) =>
  ({ key, reason, names: [name], chapters }) satisfies WorldSkip;

/** Результат первого отбора: события, которые идут в подсчёт присутствия, и отсеянные. */
export interface WorldEventsPicked {
  free: WorldEventPick[];
  leftOut: WorldSkip[];
}

/**
 * Ключи, формы и отсев до подсчёта присутствия: ключ по `eventKeyOf` (не собрать - `EVENT_KEY_INVALID`);
 * повтор ключа в ответе - одно событие (формы, главы и название второго пункта как форма
 * складываются); ключ, занятый героем анализа,
 * сущностью досье, парой хода или сохранённой сущностью другого типа (`otherKeys`, `entities`), -
 * `EVENT_KEY_TAKEN` до платного шага (запись отбилась бы 400, `checkWorldTypeFields`).
 */
export function pickEvents(
  picks: readonly WorldSelectEvent[],
  known: ReadonlySet<string>,
  otherKeys: ReadonlySet<string>,
  entities: ReadonlyMap<string, Pick<StoredWorldEntity, 'type'>>,
  useOriginal: boolean,
): WorldEventsPicked {
  const merged = new Map<string, WorldEventPick>();
  const leftOut: WorldSkip[] = [];
  for (const pick of picks) {
    const key = eventKeyOf(pick, known, useOriginal);
    if (key === null) {
      leftOut.push(
        skip(
          pick.key || pick.name.slice(0, WORLD_EVENT_KEY_MAX),
          'EVENT_KEY_INVALID',
          pick.name,
          null,
        ),
      );
      continue;
    }
    const same = merged.get(key);
    if (same) {
      // Название второго пункта - форма, только если оно стоит в тексте, как формы из `readAliases`.
      const asForm = pick.name !== same.name && pick.nameInText;
      const forms = asForm ? [pick.name, ...pick.aliases] : pick.aliases;
      same.aliases = [...new Set([...same.aliases, ...forms])];
      same.chapters = [...new Set([...same.chapters, ...pick.chapters])].sort((a, b) => a - b);
      continue;
    }
    merged.set(key, { key, name: pick.name, aliases: pick.aliases, chapters: pick.chapters });
  }
  const free: WorldEventPick[] = [];
  for (const event of merged.values()) {
    const stored = entities.get(event.key)?.type;
    if (otherKeys.has(event.key) || (stored !== undefined && stored !== 'event')) {
      leftOut.push(skip(event.key, 'EVENT_KEY_TAKEN', event.name, null));
    } else free.push(event);
  }
  return { free, leftOut };
}

/**
 * Главы, где редактор исключил **все** формы сохранённой сущности (/qa круг 3 13b-2, решение
 * `F08 | F08-13b-2` «круг 3»): исключение одной формы-тёзки главу у события не снимает - его могут
 * называть в ней другие формы или сам эпизод. Формы и исключения - то же правило, что у подсчёта
 * (`mentionForms`/`activeChapterExclusions`, `world-mentions.ts`; круг 4): свёртка `foldMention`,
 * без коротких и исключённых форм. Форм нет - исключённых глав нет.
 */
export function chaptersExcludedForAllForms(entity: WorldMentionSource): number[] {
  const forms = mentionForms(entity);
  if (forms.length === 0) return [];
  const byForm = new Map(activeChapterExclusions(entity).map((e) => [e.form, new Set(e.chapters)]));
  const [first, ...rest] = forms.map((f) => byForm.get(f) ?? new Set<number>());
  return [...first].filter((n) => rest.every((set) => set.has(n))).sort((a, b) => a - b);
}

/**
 * Главы события = главы форм названия в тексте ∪ главы из ответа выбора (Q4). `counted` - присутствие
 * по формам (`countedOf`); главы из ответа - уже только известные версии. Главы ответа идут в `named`:
 * эпизод в них происходит, даже если формы названия там не стоят, - книга страницы берёт их первыми
 * (`pageBook`), а промпт не пишет им «0 упоминаний» (`mentionLines`).
 */
export function eventMentions(
  counted: WorldEventCandidate['mentions'],
  fromAnswer: readonly number[],
  excluded: readonly number[] = [],
): WorldEventCandidate['mentions'] {
  // Глава, где редактор исключил все формы сохранённого события, - не его глава: ответ выбора её не
  // возвращает (/qa круги 2-3 13b-2, `chaptersExcludedForAllForms`; формы её уже не считают).
  const answered = fromAnswer.filter((n) => !excluded.includes(n));
  const chapters = [...new Set([...counted.chapters, ...answered])].sort((a, b) => a - b);
  const named = [...new Set(answered)].sort((a, b) => a - b);
  return { chapters, perChapter: counted.perChapter, ...(named.length > 0 ? { named } : {}) };
}

/**
 * События после подсчёта присутствия: без главы - `EVENT_NO_CHAPTER` (Q2: событие без известной
 * версии главы отсекается до платного шага); остальные по убыванию глав, при равенстве - по ключу;
 * сверх потолка - `EVENTS_MAX`.
 */
export const selectEvents = (
  counted: readonly WorldEventCandidate[],
): { list: WorldEventCandidate[]; skipped: WorldSkip[] } => selectByChapters(counted, EVENT_RULES);

/**
 * Шагов событий сверху - оценка до старта (`F08 | F08-13b` Q9): кандидатов выбор ещё не назвал -
 * потолок `WORLD_EVENTS_MAX`; язык без эталона события - 0.
 */
export const eventStepsUpperBound = (language: string): number =>
  hasWorldObjectExample(language, 'event') ? WORLD_EVENTS_MAX : 0;

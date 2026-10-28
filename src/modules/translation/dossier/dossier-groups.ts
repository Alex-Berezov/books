import { SUMMARY_SECTION_LIMITS } from '../../book-summary/dto/create-book-summary-section.dto';
import { ANSWER_CHARS_PER_TOKEN } from '../../llm/openrouter.client';

/**
 * Сводка досье по группам (`F05-Rb`): вход сводки (частичные досье или результаты прошлого
 * уровня) не влез в контекст модели - его делят на группы подряд идущих элементов, каждая
 * влезает. Здесь только чистая арифметика групп; вызовы и хранение - в обработчике и сервисе.
 */

/**
 * Токенов ответа на главу в `chapters` и `summaryPlan` группы уровня 0: на них отдана пятая часть
 * `maxTokens` - остальное занимают персонажи, сущности и события, которые в сборнике растут с числом
 * глав так же (решение арбитра `F05 | F05-12`, живой отказ группы).
 */
const CHAPTER_ANSWER_TOKENS = 80;
const CHAPTER_LISTS_SHARE = 0.2;

/**
 * Сколько глав в группе уровня 0 (`F05-12`): `chapters` и `summaryPlan` пишет только уровень 0,
 * выше их склеивает код, поэтому ответ ни одного вызова не растёт с числом глав книги. Считается
 * от текущего `maxTokens` этапа, а не хранится: правка этапа меняет и предел.
 */
export function groupChapterCap(maxTokens: number): number {
  return Math.max(1, Math.floor((CHAPTER_LISTS_SHARE * maxTokens) / CHAPTER_ANSWER_TOKENS));
}

/**
 * Нужны ли группы уровня 0 при любом входе: одна сводка перечислила бы все главы одним ответом,
 * а глав больше, чем помещается в ответ группы (`F05-12`). Одно правило на обработчик и оценку.
 */
export function exceedsChapterCap(chapters: number, maxTokens: number): boolean {
  // Глав в группе уровня 0 больше, чем помещается в её ответ, - то же правило у упаковки,
  // у отказа заведённой группы и у оценки.
  return chapters > groupChapterCap(maxTokens);
}

/**
 * Групп уровня 0 сверху для оценки - те же два условия, что у упаковки обработчика: вход
 * (`capacity` ответов в группе) и `groupChapterCap` глав. Упаковка закрывает группу по тому
 * пределу, что настал раньше: групп, закрытых по входу, не больше ⌊куски / capacity⌋, по главам -
 * ⌊главы / предел⌋, плюс последняя. 0 - групп нет, одна сводка.
 */
export function level0GroupsUpperBound(
  parts: number,
  chapters: number,
  capacity: number,
  maxTokens: number,
): number {
  if (parts <= capacity && !exceedsChapterCap(chapters, maxTokens)) return 0;
  const byInput = Number.isFinite(capacity) ? Math.floor(parts / capacity) : 0;
  return Math.min(parts, byInput + Math.floor(chapters / groupChapterCap(maxTokens)) + 1);
}

/**
 * Потолок разделов плана группы уровня 0: её доля глав в потолке разделов пересказа
 * (`SUMMARY_SECTION_LIMITS`), не меньше одного. Глава, чьи куски попали в две группы, считается
 * у обеих: на `groups` групп таких стыков меньше `groups`, поэтому делитель - главы книги плюс
 * число групп, и сумма долей вниз не больше потолка (пока доля не упирается в один раздел -
 * книги в тысячи глав на группу).
 */
export function groupSectionCap(
  groupChapters: number,
  bookChapters: number,
  groups: number,
): number {
  return Math.max(
    1,
    Math.floor(
      (SUMMARY_SECTION_LIMITS.sectionsPerVersion * groupChapters) / (bookChapters + groups),
    ),
  );
}

/** Потолки длины списков ответа сводки: персонажей, сущностей и событий хронологии. */
export interface DossierListLimits {
  characters: number;
  entities: number;
  chronology: number;
}

/**
 * Потолки списков сводки на любом уровне, уровень 0 тоже (`F05-12`, живой отказ группы): иначе
 * в сборнике, где у каждой главы свои персонажи, ответ группы и итога растёт с книгой и обрезается
 * в `maxTokens`. Считаются от текущего `maxTokens` этапа, как `groupChapterCap`.
 */
export function dossierListLimits(maxTokens: number): DossierListLimits {
  const entities = Math.max(1, Math.floor(maxTokens / 320));
  return { characters: Math.max(1, Math.floor(maxTokens / 250)), entities, chronology: entities };
}

/**
 * Обёртка элемента входа сводки сверх ответа модели: `{"chapterNumber":…,"partIndex":…,"data":…}`
 * у куска, `{"firstChapter":…,"lastChapter":…,"data":…}` у группы, плюс запятая между элементами.
 * Номера - с запасом на пять цифр.
 */
const DATA_PLACEHOLDER = 0;
const ITEM_SEPARATOR = ',';
export const SUMMARY_ITEM_WRAPPER_CHARS =
  Math.max(
    JSON.stringify({ chapterNumber: 99_999, partIndex: 99_999, data: DATA_PLACEHOLDER }).length,
    JSON.stringify({ firstChapter: 99_999, lastChapter: 99_999, data: DATA_PLACEHOLDER }).length,
  ) -
  String(DATA_PLACEHOLDER).length +
  ITEM_SEPARATOR.length;

/**
 * Сколько ответов (кусков или групп) заведомо влезет во вход одного вызова сводки: каждый -
 * до `maxTokens` токенов ответа с обёрткой. Это оценка сверху, а не упаковка: настоящие ответы
 * короче, и упаковка уложит больше.
 */
export function summaryCapacity(roomChars: number, maxTokens: number): number {
  return Math.floor(roomChars / summaryItemChars(maxTokens));
}

/** Элемент входа сводки сверху: ответ в `maxTokens` токенов с обёрткой и запятой. */
export function summaryItemChars(maxTokens: number): number {
  return maxTokens * ANSWER_CHARS_PER_TOKEN + SUMMARY_ITEM_WRAPPER_CHARS;
}

/**
 * Сколько ответов групп заведомо влезает во вход уровня выше нулевого, чтобы уровень сужался
 * (пересмотр Р3, `F05-12`): меньше - обработчик отказывает до оплаты уровня 0, оценка не считает
 * уровни по ёмкости ниже этой.
 */
export const UPPER_LEVEL_MIN_ITEMS = 2;

/**
 * Сузится ли уровень выше нулевого: во вход с `roomChars` свободного места заведомо влезает
 * `UPPER_LEVEL_MIN_ITEMS` ответов групп. Одно правило на отказ обработчика до оплаты уровня 0 и
 * на оценку, которая уровни по меньшей ёмкости не считает.
 */
export function upperLevelFits(roomChars: number, maxTokens: number): boolean {
  return summaryCapacity(roomChars, maxTokens) >= UPPER_LEVEL_MIN_ITEMS;
}

/** Число разных глав в элементах уровня 0: у каждого куска одна глава. */
export function distinctChapters(items: readonly GroupItem[]): number {
  return new Set(items.map((i) => i.firstChapter)).size;
}

/** Элемент входа уровня: частичное досье куска (уровень 0) или результат группы прошлого уровня. */
export interface GroupItem {
  firstChapter: number;
  lastChapter: number;
  /** То, что уходит в запрос сводки как есть. */
  entry: object;
}

export interface GroupSpan {
  firstItem: number;
  itemCount: number;
  firstChapter: number;
  lastChapter: number;
}

/**
 * Делит элементы на группы подряд идущих, каждая под `fits`. Группа растёт удвоением и
 * уточняется бинарным поиском, так что проб - порядка логарифма размера группы. Обработчик
 * меряет пробу сложением длин (`summaryInputChars`, Р6); `fits` остаётся асинхронным, чтобы
 * граница могла приходить и запросом. `null` - даже один элемент не влезает (`DOSSIER_TOO_LONG`).
 */
export async function packGroups(
  items: readonly GroupItem[],
  fits: (group: readonly GroupItem[]) => Promise<boolean>,
): Promise<GroupSpan[] | null> {
  const spans: GroupSpan[] = [];
  let start = 0;
  while (start < items.length) {
    if (!(await fits(items.slice(start, start + 1)))) return null;
    const left = items.length - start;
    let good = 1;
    if (left === 1) {
      spans.push({
        firstItem: start,
        itemCount: 1,
        firstChapter: items[start].firstChapter,
        lastChapter: items[start].lastChapter,
      });
      break;
    }
    // Удвоение: `bad` - первое число элементов, которое не влезло (или `left + 1`, если влезло всё).
    let bad = left + 1;
    for (let size = 2; ; size *= 2) {
      if (size >= left) {
        if (await fits(items.slice(start, start + left))) good = left;
        else bad = left;
        break;
      }
      if (await fits(items.slice(start, start + size))) good = size;
      else {
        bad = size;
        break;
      }
    }
    while (bad - good > 1) {
      const mid = Math.floor((good + bad) / 2);
      if (await fits(items.slice(start, start + mid))) good = mid;
      else bad = mid;
    }
    const taken = items.slice(start, start + good);
    spans.push({
      firstItem: start,
      itemCount: good,
      firstChapter: Math.min(...taken.map((i) => i.firstChapter)),
      lastChapter: Math.max(...taken.map((i) => i.lastChapter)),
    });
    start += good;
  }
  return spans;
}

/**
 * Число вызовов групп по уровням, когда в вызов помещается `capacity` элементов (оценка
 * сверху для лимита операции). Первый уровень может состоять из групп по одному элементу, дальше
 * уровень обязан сужаться (иначе обработчик отказывает `DOSSIER_TOO_LONG`), то есть в группе
 * не меньше двух. Последний вызов - итоговая сводка из `finalItems` элементов.
 */
export function summaryLevels(
  items: number,
  capacity: number,
): { groupsPerLevel: number[]; finalItems: number } {
  const groupsPerLevel: number[] = [];
  let n = items;
  let size = Math.max(1, capacity);
  while (n > size) {
    n = Math.ceil(n / size);
    groupsPerLevel.push(n);
    size = Math.max(2, capacity);
  }
  return { groupsPerLevel, finalItems: n };
}

/**
 * Уровень групп годится (решение арбитра `F05 | F05-Rb`, Р3): нулевой - любой, выше нулевого -
 * групп не больше половины элементов (вверх) и меньше, чем элементов. Так уровней не больше
 * log2(n), строк групп не больше 2n, а `summaryLevels` остаётся верхней границей. Нечётный хвост
 * из одного элемента отказа не даёт: считается число групп, а не размер каждой.
 */
export function levelNarrows(level: number, items: number, groups: number): boolean {
  return level === 0 || (groups < items && groups <= Math.ceil(items / 2));
}

/**
 * Длина входа сводки (`estimateInputTokens` запроса) по длинам элементов: вход -
 * `Partial dossiers: ${JSON.stringify(parts)}`, поэтому это длина запроса с пустым массивом, плюс
 * длины элементов, плюс запятые между ними. Та же величина без сериализации на каждую пробу
 * упаковки (решение арбитра `F05 | F05-Rb`, Р6).
 */
export function summaryInputChars(emptyChars: number, entryLengths: readonly number[]): number {
  const items = entryLengths.reduce((sum, n) => sum + n, 0);
  return emptyChars + items + Math.max(0, entryLengths.length - 1);
}

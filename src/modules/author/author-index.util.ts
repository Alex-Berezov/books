import { Language, Prisma } from '@prisma/client';

/**
 * Алфавитный указатель авторов: какая буква у имени и какие буквы вообще бывают.
 *
 * Всё, что здесь есть, обязано давать **один и тот же ответ** в трёх местах:
 * в фильтре по букве, в счётчиках ручки букв и в решении «это `#` или буква».
 * Разойдись они — и указатель начнёт врать: буква говорит «12», а под ней
 * оказывается восемь карточек.
 */

/**
 * Русский указатель без `Ё`, `Ъ`, `Ь`, `Ы`.
 *
 * `Ъ`, `Ь`, `Ы` не начинают ни одного имени — они висели бы погашенными всегда
 * и только занимали ширину. `Ё` свёрнута в `Е` тем же правилом, которым `É`
 * живёт под `E`: это диакритика, а не отдельный раздел указателя. `Ёлкин`
 * поэтому ищется под `Е`, как в бумажных справочниках.
 */
const RU_ALPHABET = 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЭЮЯ'.split('');

/** Латиница A-Z. Диакритика сворачивается в базовую букву, см. `FOLD_FROM`/`FOLD_TO`. */
const LATIN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/**
 * Свёртка диакритики и `Ё`, аргументы для postgres `translate()`.
 *
 * 🔴 Строки обязаны совпадать посимвольно: `translate()` сопоставляет их позиция
 * в позицию. За этим следит `assertFoldTablesAligned` ниже — молча разъехавшаяся
 * таблица дала бы неверную букву у части имён, и заметить это можно было бы
 * только глазами по указателю.
 *
 * Зачем вообще: postgres `ILIKE 'e%'` **не** ловит `Édouard`, а `unaccent` —
 * расширение, которого в схеме нет, и заводить его значило бы миграцию ради
 * указателя. `translate()` есть всегда.
 */
const FOLD_FROM = 'àáâãäåÀÁÂÃÄÅèéêëÈÉÊËìíîïÌÍÎÏòóôõöøÒÓÔÕÖØùúûüÙÚÛÜçÇñÑýÿÝšŠžŽłŁďĎğĞřŘťŤёЁ';
const FOLD_TO = 'aaaaaaAAAAAAeeeeEEEEiiiiIIIIooooooOOOOOOuuuuUUUUcCnNyyYsSzZlLdDgGrRtTеЕ';

/**
 * Таблицы свёртки читаются человеком и правятся руками, поэтому проверяются
 * при загрузке модуля, а не в тесте: тест можно забыть запустить, импорт — нет.
 */
function assertFoldTablesAligned(): void {
  const from = [...FOLD_FROM];
  const to = [...FOLD_TO];
  if (from.length !== to.length) {
    throw new Error(
      `Fold tables are misaligned: FOLD_FROM has ${from.length} chars, FOLD_TO has ${to.length}.`,
    );
  }
}
assertFoldTablesAligned();

/** Группа для имён, которые не начинаются ни с одной буквы алфавита. */
export const OTHER_LETTER = '#';

/**
 * Буквы указателя для языка страницы.
 *
 * Указатель показывает алфавит **страницы**, а не интерфейса: на `/ru/authors`
 * кириллица, на остальных четырёх — латиница. Иначе на испанской странице
 * висел бы русский алфавит из тридцати погашенных букв.
 */
export function alphabetForLanguage(lang: Language): string[] {
  return lang === Language.ru ? [...RU_ALPHABET] : [...LATIN_ALPHABET];
}

function foldChar(char: string): string {
  const at = [...FOLD_FROM].indexOf(char);
  return at === -1 ? char : [...FOLD_TO][at];
}

/**
 * Буква имени в том же виде, в каком её считает база.
 *
 * Держится рядом с `INDEX_LETTER_SQL` намеренно: два вычисления одного и того же,
 * и разъехаться им нельзя. Это — для проверок и тестов, то — для запроса.
 */
export function indexLetterOf(name: string, lang: Language): string {
  const first = foldChar((name ?? '').trim().charAt(0)).toUpperCase();
  return alphabetForLanguage(lang).includes(first) ? first : OTHER_LETTER;
}

/**
 * Первая буква имени, посчитанная в SQL: сняли краевые пробелы, свернули
 * диакритику, взяли первый символ, подняли в верхний регистр. Ровно то же, что
 * делает `indexLetterOf`, — кроме последнего шага, «буква это или `#`», который
 * остаётся вызывающему.
 *
 * ⚠️ `btrim` здесь не украшение: `indexLetterOf` делает `.trim()`, и без парного
 * `btrim` имя с ведущим пробелом попало бы у базы в `#`, а у указателя — под свою
 * букву. Шапка файла требует одинакового ответа во всех трёх местах.
 */
export const INDEX_LETTER_SQL = Prisma.sql`upper(left(translate(btrim(t.name), ${FOLD_FROM}, ${FOLD_TO}), 1))`;

/**
 * Условие «имя начинается на эту букву» либо «не начинается ни на одну» для `#`.
 *
 * ⚠️ Через свёрнутую букву, а не через `ILIKE 'д%'`. Прямое сравнение отправило бы
 * `Édouard` в `#`, хотя его место под `E`, и счётчик буквы `E` разошёлся бы
 * с числом карточек под ней.
 */
export function letterCondition(letter: string, lang: Language): Prisma.Sql {
  if (letter === OTHER_LETTER) {
    return Prisma.sql`${INDEX_LETTER_SQL} <> ALL (${alphabetForLanguage(lang)})`;
  }
  return Prisma.sql`${INDEX_LETTER_SQL} = ${indexLetterOf(letter, lang)}`;
}

/** Принимаем ли такую букву в адресе: своя буква алфавита или группа `#`. */
export function isKnownLetter(letter: string, lang: Language): boolean {
  if (letter === OTHER_LETTER) return true;
  if ([...letter].length !== 1) return false;
  return alphabetForLanguage(lang).includes(foldChar(letter).toUpperCase());
}

/**
 * Порядок букв в ответе ручки: алфавит языка, `#` последней.
 *
 * Сортировать средствами базы здесь нельзя: порядок кириллицы зависит от collation,
 * а `#` при любой collation встанет не туда, куда нужно продукту.
 */
export function sortLetters<T extends { letter: string }>(rows: T[], lang: Language): T[] {
  const order = new Map(alphabetForLanguage(lang).map((letter, at) => [letter, at]));
  const last = order.size + 1;
  return [...rows].sort((a, b) => (order.get(a.letter) ?? last) - (order.get(b.letter) ?? last));
}

/** Сколько знаков берём из биографии в карточку. */
const SHORT_BIO_LIMIT = 160;

/**
 * Сколько знаков биографии читать из базы, чтобы посчитать `SHORT_BIO_LIMIT`.
 *
 * Биография — `@db.Text`, и тянуть её целиком на все двадцать четыре карточки ради
 * ста шестидесяти знаков незачем. Запас пятикратный: разметка съедает часть бюджета
 * (`<p class="...">` — это два десятка знаков на ноль видимого текста), и обрезать
 * впритык значило бы иногда отдавать сто двадцать знаков вместо ста шестидесяти.
 */
export const SHORT_BIO_SOURCE_LIMIT = 800;

/**
 * Короткая биография для карточки: без разметки, по границе слова, с многоточием.
 *
 * 🔴 Считается **на сервере**. Отдать полную биографию и обрезать её в браузере —
 * это те самые сотни килобайт на страницу, ради которых заведён
 * `PUBLIC_AUTHOR_SELECT`, плюс разметка из CMS в вёрстке карточки.
 */
export function buildShortBio(biography: string | null | undefined): string | null {
  if (!biography) return null;

  const plain = biography
    // Хвост оборванного тега. Биография приходит из базы обрезанной
    // (`left(biography, SHORT_BIO_SOURCE_LIMIT)`), и рез может прийтись внутрь
    // `<a href="…` — такой огрызок не подходит под шаблон ниже и уехал бы
    // в карточку как текст.
    .replace(/<[^>]*$/, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    // Тег заменяется пробелом, а не пустотой: иначе `<p>раз</p><p>два</p>`
    // склеилось бы в «раздва». Расплата — пробел перед точкой у инлайновых
    // тегов (`<b>писатель</b>.` → «писатель .»), и он убирается здесь.
    .replace(/\s+([,.;:!?…»)\]])/gu, '$1')
    .replace(/([«([])\s+/gu, '$1')
    .trim();

  if (!plain) return null;
  if ([...plain].length <= SHORT_BIO_LIMIT) return plain;

  const cut = [...plain].slice(0, SHORT_BIO_LIMIT).join('');
  const lastSpace = cut.lastIndexOf(' ');
  // Слова длиннее лимита у биографии не бывает, но если пробела нет вовсе —
  // режем по лимиту, а не возвращаем строку целиком.
  const body = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.!?-]+$/u, '');
  return `${body}…`;
}

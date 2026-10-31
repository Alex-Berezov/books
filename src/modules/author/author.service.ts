import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateAuthorDto } from './dto/create-author.dto';
import { UpdateAuthorDto } from './dto/update-author.dto';
import { AdminAuditAction, AdminAuditTargetType, Language, Prisma } from '@prisma/client';
import { AdminAuditService } from '../../shared/admin-audit/admin-audit.service';
import type { AuthorPhotoCreditDto as AuthorPhotoCredit } from './dto/author-page-blocks.dto';
import { SlugRedirectService } from '../slug-redirect/slug-redirect.service';
import {
  paginated,
  PaginationInfoDto,
  totalPagesOf,
} from '../../shared/dto/paginated-response.dto';
import {
  PUBLIC_AUTHOR_PAGE_TRANSLATION_SELECT,
  PUBLIC_AUTHOR_SELECT,
  type PublicAuthorListItem,
} from '../../common/selects/public-author.select';
import {
  PUBLIC_AUTHORS_DEFAULT_LIMIT,
  PUBLIC_AUTHORS_MAX_LIMIT,
  type PublicAuthorsSort,
} from './author-listing.constants';
import {
  FOLD_FROM,
  FOLD_TO,
  OTHER_LETTER,
  SHORT_BIO_SOURCE_LIMIT,
  alphabetForLanguage,
  buildShortBio,
  indexLetterOf,
  isKnownLetter,
  sortLetters,
} from './author-index.util';
import { deleteSeoIfUnreferenced } from '../../shared/seo/seo-orphan.util';
import { suggestedSlugCandidate } from '../../shared/validators/slug';
import { escapeLikeWildcards } from '../../shared/prisma/escape-like';
import { pickSlugOwner } from '../../shared/slug/book-slug-owner';
import { seoDtoToData } from '../seo/utils/seo-dto-to-data.util';
import {
  bookCardSelect,
  bookCardSlug,
  loadBookCardRatings,
  toBookCardDto,
} from '../book/book-card';
import { BookCardDto } from '../book/dto/book-card.dto';
import {
  AdminAuthorRow,
  AuthorPageBookRef,
  AuthorPageSlugRef,
  AuthorRef,
  AuthorSlugWarning,
  PublicSimilarAuthor,
  canonicalJson,
  collectSlugRefs,
  compactBlock,
  readStoredBlocks,
  sortByYear,
  StoredAuthorPageBlocks,
  keepAbsentBlocks,
  AUTHOR_PAGE_BLOCK_KEYS,
  SLUG_REF_BLOCK_KEYS,
  type SlugRefBlockKey,
  storedBlocksToData,
  toAdminAuthor,
  toAdminTranslation,
  toJsonColumn,
  toStoredBlocks,
} from './author-page-data';
import { AuthorFaqDto as AuthorFaq, type AuthorTranslationDto } from './dto/author-translation.dto';
import type { UpdateSeoDto } from '../seo/dto/update-seo.dto';

/**
 * Первая буква имени, посчитанная в SQL: сняли краевые пробелы, свернули
 * диакритику, взяли первый символ, подняли в верхний регистр. То же, что делает
 * `indexLetterOf`, — кроме последнего шага, «буква это или `#`», который остаётся
 * вызывающему.
 *
 * ⚠️ `btrim` парен `.trim()` в `indexLetterOf`: без него имя с ведущим пробелом
 * попало бы у базы в `#`, а у указателя — под свою букву.
 *
 * 🔴 Живёт здесь, а не рядом с алфавитом в `author-index.util.ts`, потому что
 * `scripts/drift-check.mjs` связывает алиасы сырого SQL с таблицами в пределах
 * файла. В файле без `FROM "AuthorTranslation" t` фрагмент со ссылкой на `t.name`
 * не читается вовсе, а непрочитанный шаблон считается скрытой рассинхронизацией
 * (`LEGACY-123`) — CI краснеет, и правильно делает.
 */
const INDEX_LETTER_SQL = Prisma.sql`upper(left(translate(btrim(t.name), ${FOLD_FROM}, ${FOLD_TO}), 1))`;

/**
 * Условие «имя начинается на эту букву» либо «не начинается ни на одну» для `#`.
 *
 * ⚠️ Через свёрнутую букву, а не через `ILIKE 'д%'`. Прямое сравнение отправило бы
 * `Édouard` в `#`, хотя его место под `E`, и счётчик буквы `E` разошёлся бы
 * с числом карточек под ней.
 */
function letterCondition(letter: string, lang: Language): Prisma.Sql {
  if (letter === OTHER_LETTER) {
    return Prisma.sql`${INDEX_LETTER_SQL} <> ALL (${alphabetForLanguage(lang)})`;
  }
  return Prisma.sql`${INDEX_LETTER_SQL} = ${indexLetterOf(letter, lang)}`;
}

/**
 * Строка отбора страницы: автор, оба счётчика и начало биографии.
 *
 * `bioSource` — не биография, а её первые `SHORT_BIO_SOURCE_LIMIT` знаков,
 * обрезанные базой. Дальше из них считается `shortBio`, и наружу уходит только он.
 */
interface PublicAuthorPageRow {
  authorId: string;
  booksCount: number;
  audioCount: number;
  bioSource: string | null;
}

/** Параметры публичного списка авторов. Все необязательны, у каждого есть умолчание. */
export interface PublicAuthorsListOptions {
  page?: number;
  limit?: number;
  search?: string;
  letter?: string;
  sort?: PublicAuthorsSort;
  /**
   * Отбросить авторов без опубликованных книг на этом языке.
   *
   * 🔴 По умолчанию **выключен**, и включать его по умолчанию нельзя. У `booksCount`
   * есть история: до 09.08.2026 он был нулём у всех авторов, включая тех, чьи книги
   * лежали в каталоге (считался по внешнему ключу, который в проде NULL). Повторись
   * эта история при фильтре по умолчанию — и разом опустеют хаб, блок авторов
   * на главной и карта сайта авторов. Просит фильтр тот, кому он нужен: хаб и ручка букв.
   */
  hasBooks?: boolean;
}

/**
 * Связь автора с опубликованными книгами — одной формулой на все запросы.
 *
 * 🔴 Формула хрупкая и неочевидная, поэтому существует ровно один её экземпляр.
 * Обе половины `OR` рабочие, и убирать нельзя ни одну. FK `BookVersion.authorId`
 * заполнен бэкфилом от 09.08.2026 (`prisma/migrations/20260809120000_backfill_book_version_author_id`),
 * но только там, где сопоставление имени с переводом было однозначным; всё
 * остальное — и всякая версия, заведённая мимо связи, — держится на совпадении
 * имени внутри своего языка (в ru-версии книги автор записан как «Сунь-цзы»,
 * сверять его с английским «Sun Tzu» бессмысленно).
 *
 * Три места считают по ней: счётчик книг, публичный список и ручка букв.
 * Разъедься они — счётчик на карточке, число под буквой и `noindex` на странице
 * автора начали бы отвечать по-разному, и заметить это можно было бы только
 * глазами.
 *
 * ⚠️ Обе половины `OR` обязаны быть индексированы, иначе планировщик соединяет
 * таблицы по одному `language` и отбрасывает `OR` фильтром соединения —
 * на 25 000 переводов это 19 996 000 отброшенных строк и секунда на запрос
 * (`LEGACY-272`, миграция `20260902090000_authors_hub_join_indexes`). Добавляя
 * сюда третью половину, добавь и индекс под неё.
 */
const PUBLISHED_BOOKS_JOIN = Prisma.sql`
  ON bv.language = t.language
 AND bv.status = 'published'
 AND (bv."authorId" = t."authorId" OR bv.author = t.name)`;

/**
 * Ключ карты слагов: слаг уникален парой `@@unique([language, slug])`
 * (`prisma/schema.prisma`), поэтому и искать его можно только парой. Одна функция
 * на запись и на чтение — врозь они разъедутся на первой же правке разделителя.
 */
export function authorSlugKey(authorId: string, language: Language): string {
  return `${authorId}:${language}`;
}

/** Сколько кандидатов `<slug>-N` проверяет один запрос подсказки (LEGACY-370). */
const SLUG_SUGGESTION_BATCH = 20;

/**
 * Предохранитель выборки книг автора для «Вводных для промпта» и для счёта оценок шапки:
 * безлимитная выборка в память в публичной ручке запрещена. Порог выше любого автора
 * каталога; `booksTotal` считается отдельно и предохранителем не режется.
 */
const AUTHOR_PAGE_BOOKS_CAP = 500;

/**
 * Порция книг страницы автора (F02-3, `product.md` §7): первые 12 по году, остальное
 * догружает «Показать все» через `/books/cards` тем же набором и порядком.
 */
const AUTHOR_PAGE_BOOKS_FIRST = 12;

/**
 * Опубликованные книги автора на языке: по `authorId` или, у книг без связи, по имени.
 * Один набор на страницу, `/books/cards` автора и агрегаты шапки (`tech.md` F02, §4).
 */
function publishedAuthorBooksWhere(
  author: { id: string; name: string | null },
  language: Language,
): Prisma.BookVersionWhereInput {
  return {
    language,
    status: 'published',
    OR: author.name
      ? [{ authorId: author.id }, { author: author.name }]
      : [{ authorId: author.id }],
  };
}

/** Сколько слагов из `similarSlugs` разрешает страница автора: блок — ряд имён, не каталог. */
const SIMILAR_AUTHORS_MAX = 20;

/**
 * Предохранитель на число слагов книг или авторов, которые разрешаются за одну страницу
 * автора (F02-2): блоки ограничены DTO, кроме цитат — их число DTO не ограничивает.
 */
const AUTHOR_PAGE_REFS_MAX = 100;

/**
 * Предохранитель списка авторов во «Вводных для промпта» — строк переводов, не авторов
 * (`books/CLAUDE.md`: выборка в память — с пределом). Упёрлись — ответ говорит об обрезке.
 */
const PROMPT_INPUT_AUTHOR_ROWS_CAP = 10_000;

/**
 * Границы транзакции удаления автора (`LEGACY-015`, пачка `T21`). Те же цифры, что
 * у персоны, страницы и книги: расхождение здесь значило бы, что один и тот же отказ
 * базы ведёт себя по-разному в зависимости от того, что именно удаляют.
 *
 * ⚠️ Транзакции здесь не было вовсе - удаление шло парой `findUnique` + `delete` по
 * корневому клиенту. Заведена она ради атомарности записи в журнал (`LEGACY-036`),
 * а **не** ради закрытия гонки: `SELECT ... FOR UPDATE` на строку автора решением
 * арбитра 20.09.2026 в эту пачку не берётся (`decisions-log.md`). Встречная правка
 * перевода в окне между чтением списка слагов и удалением по-прежнему возможна,
 * и список в `payload` может от неё разойтись - это отдельная строка техдолга,
 * а не закрытый здесь случай (`L-019`: транзакция без замка гонку не сужает).
 */
const AUTHOR_DELETE_TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;
// Правка ждёт замка строки (`LEGACY-320`): дефолтных 5 с на ожидание не хватит (`L-020`).
const AUTHOR_UPDATE_TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;

/** Поля SEO, которые пишет форма автора: по ним и сравнивается содержимое перевода. */
const SEO_CONTENT_KEYS = Object.keys(seoDtoToData({} as UpdateSeoDto));

/** Поля перевода, смена которых двигает его `updatedAt` (решение арбитра 15.10.2026, `F02 | F02-2`). */
const TRANSLATION_CONTENT_KEYS = [
  'slug',
  'name',
  'biography',
  'wikidataUrl',
  'wikipediaUrl',
  'photoUrl',
  'faq',
  'similarSlugs',
  'quotes',
  // Блоки F02-2 — тем же списком, что пишет запись: новый блок попадает в сравнение сам.
  ...AUTHOR_PAGE_BLOCK_KEYS,
] as const satisfies ReadonlyArray<keyof AuthorTranslationDto>;

/**
 * Ключ содержимого перевода: одинаковый ключ у старой строки и у пришедшей — перевод
 * не менялся, и `AuthorService.update`, пересоздавая его, переносит прежнюю дату.
 * Порядок ключей в JSON и `undefined` против `null` различием не считаются.
 */
function translationContentKey(
  translation: Partial<Record<(typeof TRANSLATION_CONTENT_KEYS)[number], unknown>>,
  seo: Record<string, unknown> | null,
): string {
  const content: Record<string, unknown> = {};
  // Хранимый вид обеих сторон: `[]`, `{}`, `''` и `null` — одно «нет значения», строки без краёв.
  // Иначе старая строка с `quotes: []` против записи `null` считалась бы правкой (решение арбитра В1).
  for (const key of TRANSLATION_CONTENT_KEYS) content[key] = compactBlock(translation[key]);
  content.seo = seo
    ? compactBlock(Object.fromEntries(SEO_CONTENT_KEYS.map((k) => [k, seo[k]])))
    : null;
  return canonicalJson(content);
}

@Injectable()
export class AuthorService {
  private readonly logger = new Logger(AuthorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly slugRedirects: SlugRedirectService,
    private readonly adminAudit: AdminAuditService,
  ) {}

  /**
   * Связывает версию книги с автором **ключом**, а не только строкой.
   *
   * 🔴 `BookVersion.authorId` принимался в DTO и раньше, но его не присылал никто:
   * на 09.08.2026 в проде он был NULL у **всех 45** версий, а фактическая связь
   * держалась на строковом поле `author`. Из-за этого список авторов показывал
   * «0 книг» у всех десяти, включая тех, чьи книги лежат в каталоге, а связанные
   * книги на странице книги искались обходным путём по нормализованной строке.
   *
   * Поэтому ключ выводится **здесь**, а не в форме админки. Форма — лишь один из
   * писателей: есть ещё импорт и приёмка прав, и починка одной формы вернула бы
   * расхождение с первой же записью из другого места.
   *
   * 🔴 Метод живёт в `AuthorService`, а не в `BookVersionService`, потому что
   * писателей версий **двое**: форма админки (`BookVersionService.create`/`update`)
   * и приёмка прав (`RightsBookCreationService`). Приватный метод первого второму
   * не виден, а внедрить `BookVersionService` в приёмку нельзя — `BookVersionModule`
   * сам импортирует `RightsIntakeModule` (`book-version.module.ts`), получилось бы
   * кольцо. `AuthorModule` — лист: из прикладных модулей он не импортирует ничего,
   * и резолвинг автора по имени принадлежит домену автора
   * (`LEGACY-006`, решение арбитра 19.09.2026).
   *
   * Явно переданный `authorId` имеет приоритет: у человека может быть причина
   * связать версию с автором, чьё имя записано иначе.
   *
   * Не найдено совпадение — остаётся NULL, и это правильный ответ, а не сбой:
   * автора может не быть в справочнике вовсе. Поштучный резолвинг книг автора
   * по-прежнему имеет fallback по имени, так что связь не теряется.
   */
  async resolveAuthorIdByName(
    tx: Prisma.TransactionClient,
    language: Language,
    authorName: string | undefined,
    explicitAuthorId?: string | null,
  ): Promise<string | null | undefined> {
    if (explicitAuthorId !== undefined && explicitAuthorId !== null) return explicitAuthorId;
    if (!authorName) return explicitAuthorId;

    const match = await tx.authorTranslation.findFirst({
      where: { language, name: authorName },
      select: { authorId: true },
    });

    return match?.authorId ?? explicitAuthorId ?? null;
  }

  /**
   * Настоящие слаги авторов — батчем, одним запросом, **строго в запрошенном языке**.
   *
   * 🔴 Публичный адрес автора — это `AuthorTranslation.slug`, и вывести его из имени
   * нельзя: слаг бывает транслитерацией («Сунь-цзы» → `sun-czy`, а не `sun-tzu`),
   * а при коллизии — иметь суффикс. Собранная из имени строка ведёт в 404 или, хуже,
   * на чужую страницу. Запрет записан прямо в контракте фронта
   * (`books-front/types/api-schema/books.ts`, `BookCardModel.authorSlug`:
   * «do NOT generate from display name»).
   *
   * 🔴 **Фолбэка на английский здесь нет, и заводить его нельзя.** Слаг существует
   * только в паре с языком: `getPublicBySlug` (`:893-906`) ищет
   * `findFirst({ where: { slug, language } })` и при промахе бросает `NotFoundException`,
   * а фронт отдаёт этот 404 читателю. Значит английский слаг, подставленный в адрес
   * под `/ru`, — не «ссылка про запас», а гарантированно битый переход. Нет перевода
   * на нужный язык — ключа в карте нет, вызывающий отдаёт `null`, и потребитель рисует
   * имя текстом без ссылки. До 19.09.2026 фолбэк здесь был (унаследован из приватного
   * `BookService.getAuthorSlugs`) и давал ровно тот дефект, ради которого заведена
   * запись `LEGACY-006`; снят решением арбитра 19.09.2026.
   *
   * Язык спрашивается **на каждого автора отдельно**, а не один на вызов: у обзора книги
   * версии разноязычные, и слаг версии обязан быть в языке этой версии, иначе ссылка
   * из `versions[fr]` уедет с русским слагом.
   *
   * LEGACY-006: живёт здесь, а не в `BookService`, потому что потребителей трое —
   * карточки книг, обзор книги и разметка `schema.org` в `SeoService`. Третья копия
   * того же запроса разошлась бы с остальными молча.
   */
  async getSlugsByAuthorIds(
    wanted: Array<{ authorId: string; language: Language }>,
  ): Promise<Map<string, string>> {
    if (wanted.length === 0) return new Map();

    const authorIds = Array.from(new Set(wanted.map((w) => w.authorId)));
    const languages = Array.from(new Set(wanted.map((w) => w.language)));

    const translations = await this.prisma.authorTranslation.findMany({
      where: { authorId: { in: authorIds }, language: { in: languages } },
      select: { authorId: true, language: true, slug: true },
    });

    const map = new Map<string, string>();
    for (const t of translations) {
      map.set(authorSlugKey(t.authorId, t.language), t.slug);
    }
    return map;
  }

  /**
   * Сколько **опубликованных книг** у каждого из авторов — батчем.
   *
   * 🔴 Считать по одному внешнему ключу `BookVersion.authorId` нельзя. До
   * 09.08.2026 он был NULL у всех опубликованных версий, и `_count.bookVersions`
   * давал ноль **всем десяти** авторам, включая тех, чьи книги лежат в каталоге;
   * бэкфил той же даты заполнил его лишь там, где имя сопоставилось однозначно.
   * Для остального связь по-прежнему держится на строковом `BookVersion.author`.
   *
   * Поэтому здесь тот же fallback, что уже работает поштучно в
   * `getPublicBySlug`: `authorId` **или** совпадение имени. Имя при этом
   * сравнивается со своим языком (`bv.language = t.language`) — в ru-версии книги
   * автор записан как «Сунь-цзы», и сверять его с английским «Sun Tzu» было бы
   * бессмысленно.
   *
   * Считаются различные **книги**, а не версии: одна книга в трёх языках — одна
   * книга, иначе счётчик мерил бы полноту перевода, а не наполненность автора.
   */
  private async countPublishedBooksByAuthor(authorIds: string[]): Promise<Map<string, number>> {
    if (authorIds.length === 0) return new Map();

    const rows = await this.prisma.$queryRaw<Array<{ authorId: string; booksCount: number }>>`
      SELECT t."authorId", COUNT(DISTINCT bv."bookId")::int AS "booksCount"
      FROM "AuthorTranslation" t
      JOIN "BookVersion" bv ${PUBLISHED_BOOKS_JOIN}
      WHERE t."authorId" IN (${Prisma.join(authorIds)})
      GROUP BY t."authorId"
    `;

    return new Map(rows.map((r) => [r.authorId, r.booksCount]));
  }

  /**
   * Форма элемента админской выдачи автора — одна на список и на одиночное чтение.
   *
   * 🔴 Одним методом, а не двумя копиями: `GET /admin/authors/:id` обещает
   * в Swagger «ту же форму, что элемент списка», и держать это обещание должен
   * код, а не дисциплина. Разъедься копии — админский список показал бы новое
   * поле, а страница правки отдала бы по нему `undefined`, причём `tsc`
   * промолчал бы: обе стороны читает один рукописный тип `Author` на фронте.
   *
   * Перевод для верхнеуровневых полей — английский, иначе первый попавшийся.
   */
  private toAuthorItem(
    // Тип с `seo` внутри перевода, а не просто `translations: true`: оба
    // вызывающих читают его с `include: { seo: true }`, и на узком типе снятие
    // этого `include` у любого из них прошло бы мимо `tsc` — то есть страховка,
    // ради которой метод и заведён, не сработала бы.
    author: Prisma.AuthorGetPayload<{ include: { translations: { include: { seo: true } } } }>,
    booksCount: number,
  ) {
    const mainTrans =
      author.translations.find((t) => t.language === 'en') || author.translations[0];

    return {
      id: author.id,
      slug: mainTrans?.slug || '',
      name: mainTrans?.name || '',
      birthDate: author.birthDate,
      deathDate: author.deathDate,
      nativeName: author.nativeName,
      photoCredit: author.photoCredit as unknown as AuthorPhotoCredit | null,
      wikidataUrl: mainTrans?.wikidataUrl || null,
      wikipediaUrl: mainTrans?.wikipediaUrl || null,
      photoUrl: mainTrans?.photoUrl || null,
      translations: author.translations.map(toAdminTranslation),
      booksCount,
    };
  }

  async list(page = 1, limit = 20, search?: string) {
    const skip = (page - 1) * limit;

    const term = search?.trim();
    const where: Prisma.AuthorWhereInput | undefined = term
      ? {
          translations: {
            some: { name: { contains: escapeLikeWildcards(term), mode: 'insensitive' } },
          },
        }
      : undefined;

    const [total, items] = await this.prisma.$transaction([
      this.prisma.author.count({ where }),
      this.prisma.author.findMany({
        where,
        // `id` — второй ключ: авторы одного импорта делят `createdAt`, и без него
        // постраничное листание экрана могло бы показать автора дважды или потерять.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
        include: {
          translations: {
            include: { seo: true },
          },
        },
      }),
    ]);

    const booksCounts = await this.countPublishedBooksByAuthor(items.map((item) => item.id));

    // Единая форма списка (`LEGACY-177`). Метод обслуживает **только** админский
    // `GET /admin/authors` (`author.controller.ts`): публичная выдача авторов идёт
    // отдельным `listPublic`, поэтому форму можно менять здесь, а не обёрткой
    // в контроллере, и ни один кэшируемый публичный ответ этим не задет.
    return paginated(
      items.map((item) => this.toAuthorItem(item, booksCounts.get(item.id) ?? 0)),
      { page, limit, total },
    );
  }

  /**
   * Одиночное чтение для админки (`LEGACY-352`). Экран правки автора раньше искал
   * запись в первой странице `list()` — за сотым автором (потолок `LEGACY-217`)
   * поиск молча переставал находить существующую запись.
   */
  async findOne(id: string) {
    const author = await this.prisma.author.findUnique({
      where: { id },
      include: { translations: { include: { seo: true } } },
    });
    if (!author) {
      throw new NotFoundException(`Author with ID '${id}' not found`);
    }

    const booksCounts = await this.countPublishedBooksByAuthor([author.id]);
    return this.toAuthorItem(author, booksCounts.get(author.id) ?? 0);
  }

  /**
   * Публичный список авторов для хаба `/:lang/authors`.
   *
   * Отдельный метод, а не параметры к `list()`, по трём причинам сразу:
   *
   * 1. `list()` ходит из админки и обязан отдавать переводы целиком; публичному
   *    списку это запрещено (`PUBLIC_AUTHOR_SELECT`, `LEGACY-214`).
   * 2. Он идёт от `Author`, а фильтровать надо по `AuthorTranslation.name` —
   *    поиск и буква живут в переводе, а не в авторе.
   * 3. Сортировка по числу книг обязана резать страницу **в SQL**. Счётчик
   *    считается сырым запросом, и «взять всех, отсортировать в памяти, потом
   *    отрезать двадцать четыре» на тысяче авторов собрало бы страницу
   *    из случайных людей (`B11`).
   *
   * Отбор страницы и оба счётчика — один запрос; ещё один считает `total`; ещё
   * два добирают отображаемые поля. Четыре запроса независимо от размера
   * страницы, ни одного в цикле по автору.
   */
  async listPublic(
    lang: Language,
    options: PublicAuthorsListOptions = {},
  ): Promise<{ data: PublicAuthorListItem[]; meta: PaginationInfoDto }> {
    const { search, letter, sort = 'name', hasBooks = false } = options;

    // 🔴 Буква проверяется здесь, а не только в DTO: алфавит зависит от языка
    // пути, а DTO о языке не знает. Без проверки `?letter=W` на `/ru/` уходил
    // в `indexLetterOf`, сводился к литералу `'#'` и отдавал 200 с пустым
    // списком — при том, что настоящая группа `#` строится другим предикатом
    // (`<> ALL`). Два написания одного ведра отвечали по-разному, и ответ
    // ещё и оседал в общем кэше на пять минут.
    if (letter && !isKnownLetter(letter, lang)) {
      throw new BadRequestException(
        `letter must be a single letter of the ${lang} alphabet or "${OTHER_LETTER}"`,
      );
    }

    const page = Math.max(1, Math.trunc(Number(options.page) || 1));
    const limit = Math.min(
      Math.max(1, Math.trunc(Number(options.limit) || PUBLIC_AUTHORS_DEFAULT_LIMIT)),
      PUBLIC_AUTHORS_MAX_LIMIT,
    );
    const skip = (page - 1) * limit;

    const conditions = this.buildPublicAuthorConditions(lang, search, letter);
    // Считается по авторам, а не по строкам join'а: без `hasBooks` фильтра нет
    // вовсе, поэтому и `HAVING` не пишется — пустой `HAVING` postgres не примет.
    const having = hasBooks ? Prisma.sql`HAVING COUNT(DISTINCT bv."bookId") > 0` : Prisma.empty;

    // Имя добавлено вторым ключом к обеим сортировкам: без него порядок внутри
    // группы «столько же книг» и внутри тёзок не определён, и одна и та же
    // страница при двух запросах отдавала бы разных людей.
    const orderBy =
      sort === 'books'
        ? Prisma.sql`ORDER BY "booksCount" DESC, t.name ASC, t."authorId" ASC`
        : Prisma.sql`ORDER BY t.name ASC, t."authorId" ASC`;

    const [rows, totals] = await Promise.all([
      this.prisma.$queryRaw<PublicAuthorPageRow[]>`
        SELECT
          t."authorId" AS "authorId",
          COUNT(DISTINCT bv."bookId")::int AS "booksCount",
          COUNT(DISTINCT bv."bookId") FILTER (WHERE bv.type = 'audio')::int AS "audioCount",
          MIN(left(t.biography, ${SHORT_BIO_SOURCE_LIMIT})) AS "bioSource"
        FROM "AuthorTranslation" t
        LEFT JOIN "BookVersion" bv ${PUBLISHED_BOOKS_JOIN}
        WHERE ${Prisma.join(conditions, ' AND ')}
        GROUP BY t."authorId", t.name
        ${having}
        ${orderBy}
        LIMIT ${limit} OFFSET ${skip}
      `,
      this.prisma.$queryRaw<Array<{ total: number }>>`
        SELECT COUNT(*)::int AS total FROM (
          SELECT t."authorId"
          FROM "AuthorTranslation" t
          LEFT JOIN "BookVersion" bv ${PUBLISHED_BOOKS_JOIN}
          WHERE ${Prisma.join(conditions, ' AND ')}
          GROUP BY t."authorId", t.name
          ${having}
        ) matched
      `,
    ]);

    const total = totals[0]?.total ?? 0;
    const meta = { page, limit, total, totalPages: totalPagesOf(total, limit) };

    if (rows.length === 0) return { data: [], meta };

    const authorIds = rows.map((row) => row.authorId);
    const [authors, pageTranslations] = await this.prisma.$transaction([
      this.prisma.author.findMany({
        where: { id: { in: authorIds } },
        select: PUBLIC_AUTHOR_SELECT,
      }),
      this.prisma.authorTranslation.findMany({
        where: { authorId: { in: authorIds }, language: lang },
        select: PUBLIC_AUTHOR_PAGE_TRANSLATION_SELECT,
      }),
    ]);

    const authorById = new Map(authors.map((author) => [author.id, author]));
    const translationByAuthor = new Map(pageTranslations.map((tr) => [tr.authorId, tr]));

    // Порядок задаёт SQL — он единственный знает про сортировку по числу книг.
    // Пересобирать его по `authors` нельзя: `findMany` вернёт свой.
    return {
      data: rows.flatMap((row) => {
        const author = authorById.get(row.authorId);
        const translation = translationByAuthor.get(row.authorId);
        // Перевод на язык страницы есть по построению выборки. Пропуск здесь —
        // не «нет данных», а расхождение между двумя запросами, и молча
        // подставлять пустое имя со ссылкой в никуда мы не станем.
        if (!author || !translation) return [];

        return [
          {
            id: author.id,
            slug: translation.slug,
            name: translation.name,
            birthDate: author.birthDate,
            deathDate: author.deathDate,
            photoUrl: translation.photoUrl,
            shortBio: buildShortBio(row.bioSource),
            booksCount: row.booksCount,
            audioCount: row.audioCount,
            translations: author.translations.map((tr) => ({
              language: tr.language,
              slug: tr.slug,
              name: tr.name,
            })),
          },
        ];
      }),
      meta,
    };
  }

  /**
   * Счётчики алфавитного указателя: `[{ letter, count }]`, алфавит языка, `#` последней.
   *
   * ⚠️ Фильтр «только с книгами» здесь включён **всегда** и параметром не управляется.
   * Единственный потребитель — хаб, а он показывает только авторов с книгами
   * (`seo-rules.md`: ссылка, карта сайта и robots обязаны решать одинаково).
   * Дай ручке считать всех — и буква скажет «12» там, где под ней восемь карточек.
   *
   * Алфавит отдаётся целиком, включая буквы с нулём: погашенную букву рисует фронт,
   * и знать состав алфавита пяти языков ему для этого не требуется.
   *
   * `search` повторяет отбор списка: указатель показывается над отфильтрованной
   * сеткой, и его счётчики обязаны описывать её же.
   */
  async listPublicLetters(
    lang: Language,
    search?: string,
  ): Promise<Array<{ letter: string; count: number }>> {
    // Счётчик буквы обязан совпадать с числом карточек под ней, а при активном
    // поиске сетка отфильтрована. Без этого же условия указатель говорил бы
    // «Д — 12» над выдачей из двух человек.
    const conditions = this.buildPublicAuthorConditions(lang, search);

    const rows = await this.prisma.$queryRaw<Array<{ letter: string; count: number }>>`
      SELECT letter, COUNT(*)::int AS count FROM (
        SELECT ${INDEX_LETTER_SQL} AS letter
        FROM "AuthorTranslation" t
        LEFT JOIN "BookVersion" bv ${PUBLISHED_BOOKS_JOIN}
        WHERE ${Prisma.join(conditions, ' AND ')}
        GROUP BY t."authorId", t.name
        HAVING COUNT(DISTINCT bv."bookId") > 0
      ) matched
      GROUP BY letter
    `;

    // База считает первую букву; «своя это буква или `#`» решается здесь, одним
    // правилом с `indexLetterOf`, а не вторым выражением внутри запроса.
    const counts = new Map<string, number>(alphabetForLanguage(lang).map((letter) => [letter, 0]));
    counts.set(OTHER_LETTER, 0);

    for (const row of rows) {
      const letter = counts.has(row.letter) ? row.letter : OTHER_LETTER;
      counts.set(letter, (counts.get(letter) ?? 0) + row.count);
    }

    return sortLetters(
      [...counts.entries()].map(([letter, count]) => ({ letter, count })),
      lang,
    );
  }

  /**
   * Общая часть `WHERE` публичного списка: язык страницы, поиск по имени, буква.
   *
   * Вынесено, потому что тем же условием считается `total`. Разъедься эти два
   * набора — и пагинация показала бы число страниц от одной выборки, а карточки
   * от другой.
   */
  private buildPublicAuthorConditions(
    lang: Language,
    search?: string,
    letter?: string,
  ): Prisma.Sql[] {
    const conditions: Prisma.Sql[] = [Prisma.sql`t.language = ${lang}::"Language"`];

    const term = search?.trim();
    if (term) {
      // `%` и `_` в запросе пользователя — это символы, а не подстановки:
      // поиск «100%» иначе совпал бы со всеми именами разом.
      const escaped = escapeLikeWildcards(term);
      conditions.push(Prisma.sql`t.name ILIKE ${`%${escaped}%`} ESCAPE '\\'`);
    }

    if (letter) conditions.push(letterCondition(letter, lang));

    return conditions;
  }

  async create(dto: CreateAuthorDto) {
    // Determine the photo to sync across all translations
    // Find the first translation that contains a non-empty photoUrl
    const syncedPhotoUrl = dto.translations.find((t) => t.photoUrl)?.photoUrl || null;

    // Check slug uniqueness in translations table for all translations
    for (const t of dto.translations) {
      const existingTrans = await this.prisma.authorTranslation.findFirst({
        where: { language: t.language, slug: t.slug },
      });
      if (existingTrans) {
        throw new BadRequestException(
          `Author translation with slug '${t.slug}' for language '${t.language}' already exists`,
        );
      }
    }

    let created: AdminAuthorRow;
    try {
      created = await this.prisma.author.create({
        data: {
          birthDate: dto.birthDate,
          deathDate: dto.deathDate,
          nativeName: compactBlock(dto.nativeName) as string | null,
          photoCredit: toJsonColumn(compactBlock(dto.photoCredit)),
          translations: {
            create: dto.translations.map((t) => ({
              language: t.language,
              slug: t.slug,
              name: t.name,
              biography: t.biography,
              wikidataUrl: t.wikidataUrl,
              wikipediaUrl: t.wikipediaUrl,
              photoUrl: t.photoUrl || syncedPhotoUrl,
              ...storedBlocksToData(toStoredBlocks(t)),
              faq: t.faq as unknown as Prisma.InputJsonValue,
              similarSlugs: t.similarSlugs as unknown as Prisma.InputJsonValue,
              seo: t.seo
                ? {
                    create: seoDtoToData(t.seo),
                  }
                : undefined,
            })),
          },
        },
        include: {
          translations: {
            include: { seo: true },
          },
        },
      });
    } catch (error) {
      throw this.internalFailure('Failed to create author', error);
    }
    // После фиксации записи: предупреждения о ненайденных слагах сохранение не отменяют
    // (решение арбитра 15.10.2026, `F02 | F02-2`).
    return { ...toAdminAuthor(created), warnings: await this.computeSlugWarnings(created.id) };
  }

  async update(id: string, dto: UpdateAuthorDto) {
    const author = await this.prisma.author.findUnique({ where: { id } });
    if (!author) {
      throw new NotFoundException(`Author with ID '${id}' not found`);
    }

    // Determine the photo to sync across all translations
    let syncedPhotoUrl: string | null | undefined = undefined;
    if (dto.translations) {
      syncedPhotoUrl = dto.translations.find((t) => t.photoUrl)?.photoUrl;
      // If photoUrl is explicitly set in one of translations but others have it empty, we sync it.
      // If none set it but we have an old photo, we might keep it.
    }

    // Validate slugs for uniqueness
    if (dto.translations) {
      for (const t of dto.translations) {
        const existingTrans = await this.prisma.authorTranslation.findFirst({
          where: {
            language: t.language,
            slug: t.slug,
            NOT: { authorId: id },
          },
        });
        if (existingTrans) {
          throw new BadRequestException(
            `Author translation with slug '${t.slug}' for language '${t.language}' already exists`,
          );
        }
      }
    }

    let updated: AdminAuthorRow | null;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        // 🔴 `LEGACY-320`: строка автора запирается первым оператором, до чтения
        // старых слагов переводов. `tx.author.update` ниже замка не даёт: при пустых
        // `birthDate`/`deathDate` Prisma не шлёт `UPDATE` вовсе, и встречная правка
        // того же автора читала переводы до коммита соседа — редирект уходил
        // с устаревшего слага. `FOR NO KEY UPDATE` — как у книги (решение арбитра
        // 25.09.2026).
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Author" WHERE id = ${id} FOR NO KEY UPDATE`;
        if (locked.length === 0) {
          throw new NotFoundException(`Author with ID '${id}' not found`);
        }

        // Update main fields
        await tx.author.update({
          where: { id },
          data: {
            birthDate: dto.birthDate,
            deathDate: dto.deathDate,
            // Не пришло — не трогаем; пришло `null` или пустое — очищаем (T5).
            nativeName:
              dto.nativeName === undefined
                ? undefined
                : (compactBlock(dto.nativeName) as string | null),
            photoCredit:
              dto.photoCredit === undefined
                ? undefined
                : toJsonColumn(compactBlock(dto.photoCredit)),
          },
        });

        // Update translations if provided
        if (dto.translations) {
          // Find old translation's seoIds to delete them to avoid orphans
          const oldTranslations = await tx.authorTranslation.findMany({
            where: { authorId: id },
            // `language` и `slug` читаются ради истории слагов (LEGACY-062): переводы
            // здесь удаляются и создаются заново, поэтому старый адрес исчезает в том
            // же deleteMany, где появляется новый. Не прочитать его сейчас — значит
            // потерять безвозвратно: сравнивать после удаления будет уже не с чем.
            //
            // Содержимое и `updatedAt` читаются ради даты перевода (решение арбитра 15.10.2026,
            // `F02 | F02-2`): перевод, чьё содержимое не изменилось, сохраняет прежнюю дату.
            include: { seo: true },
          });
          const oldByLanguage = new Map(oldTranslations.map((t) => [t.language, t]));
          const seoIdsToDelete = oldTranslations
            .map((t) => t.seoId)
            .filter((sid): sid is number => sid !== null);

          // If syncedPhotoUrl is not provided in current translations, fallback to previous photoUrl
          const existingPhoto = oldTranslations.find((t) => t.photoUrl)?.photoUrl || null;
          const finalPhoto = syncedPhotoUrl !== undefined ? syncedPhotoUrl : existingPhoto;

          // Слаг автора — публичный адрес `/{lang}/author/{slug}`, и он существует
          // только на уровне перевода: базового слага у Author нет. Значит история
          // пишется по каждому языку отдельно, до удаления переводов и в той же
          // транзакции (LEGACY-062).
          //
          // ⚠️ Язык, ВЫПАВШИЙ из dto.translations, эта запись не спасает: его перевод
          // удаляется, преемника нет, и record() тут неприменим в принципе. Адрес
          // умирает так же необратимо, как при переименовании, — класс остаётся
          // открытым и записан отдельно.
          const oldSlugByLanguage = new Map(oldTranslations.map((t) => [t.language, t.slug]));
          for (const t of dto.translations) {
            const oldSlug = oldSlugByLanguage.get(t.language);
            if (oldSlug && t.slug && oldSlug !== t.slug) {
              await this.slugRedirects.record(
                {
                  entityType: 'author',
                  language: t.language,
                  oldSlug,
                  newSlug: t.slug,
                },
                tx,
              );
            }
          }

          // Delete existing translations (which sets their relations to null)
          await tx.authorTranslation.deleteMany({ where: { authorId: id } });

          // Clean up old Seo records — только ничьи: строка может делиться с сущностью
          // другого типа (`LEGACY-400`, `T55b`).
          for (const seoId of seoIdsToDelete) {
            await deleteSeoIfUnreferenced(tx, seoId);
          }

          // Re-create translations
          for (const t of dto.translations) {
            const old = oldByLanguage.get(t.language);
            // T5: блока нет в теле — прежнее значение остаётся (старая вкладка админки,
            // скрипт); очищает только явный `null` или пустое значение.
            const blocks = keepAbsentBlocks(toStoredBlocks(t), t, old);
            const photoUrl = t.photoUrl || finalPhoto;
            const unchanged =
              old !== undefined &&
              translationContentKey(
                { ...t, ...blocks, photoUrl },
                t.seo ? seoDtoToData(t.seo) : null,
              ) === translationContentKey(old, old.seo);
            await tx.authorTranslation.create({
              data: {
                author: { connect: { id } },
                language: t.language,
                slug: t.slug,
                name: t.name,
                biography: t.biography,
                wikidataUrl: t.wikidataUrl,
                wikipediaUrl: t.wikipediaUrl,
                photoUrl,
                ...storedBlocksToData(blocks),
                updatedAt: unchanged ? old.updatedAt : new Date(),
                faq: t.faq as unknown as Prisma.InputJsonValue,
                similarSlugs: t.similarSlugs as unknown as Prisma.InputJsonValue,
                seo: t.seo
                  ? {
                      create: seoDtoToData(t.seo),
                    }
                  : undefined,
              },
            });
          }
        }

        return tx.author.findUnique({
          where: { id },
          include: {
            translations: {
              include: { seo: true },
            },
          },
        });
      }, AUTHOR_UPDATE_TX_OPTIONS);
    } catch (error) {
      throw this.internalFailure('Failed to update author', error);
    }
    return updated && { ...toAdminAuthor(updated), warnings: await this.computeSlugWarnings(id) };
  }

  /**
   * `LEGACY-015`, пачка `T21`. Удаление автора пишет `AUTHOR_DELETED` **тем же `tx`**,
   * что и сама строка: запись, пережившая откат своей операции, - это `LEGACY-036`.
   *
   * Переводы читаются до удаления и уходят в `payload` списком `{ language, slug }`:
   * `AuthorTranslation.author` стоит под `onDelete: Cascade` (`schema.prisma:659`),
   * вместе с переводами умирают публичные адреса `/:lang/authors/:slug` на всех языках
   * сразу, и после `delete` взять их неоткуда. Один лишний запрос на админском маршруте
   * удаления - цена того, что журнал может ответить, какой адрес перестал существовать.
   *
   * ⚠️ В `payload` уходят только язык и слаг. `name`, `biography` и `photoUrl` того же
   * перевода - персональные данные, а журнал выката и выгрузку базы читает кто угодно
   * (инвариант докблока `AdminAuditEvent`). Слаг персональными данными не является:
   * он и был публичным адресом.
   */
  async delete(id: string, actorUserId: string) {
    return this.prisma.$transaction(async (tx) => {
      // 🔴 `T55b`: строка автора запирается до чтения переводов — встречная правка (`update` держит
      // её `FOR NO KEY UPDATE` и пересоздаёт переводы с новым `Seo`) иначе оставляла бы уборку
      // ниже со снимком старых `seoId`, а новые строки `Seo` — сиротами после каскада.
      const [author] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Author" WHERE id = ${id} FOR UPDATE`;
      if (!author) {
        throw new NotFoundException(`Author with ID '${id}' not found`);
      }

      const dyingRows = await tx.authorTranslation.findMany({
        where: { authorId: id },
        select: { language: true, slug: true, seoId: true },
        orderBy: { language: 'asc' },
      });
      // Состав `payload` журнала — ровно `{ language, slug }`: `seoId` нужен только уборке ниже.
      const dying = dyingRows.map(({ language, slug }) => ({ language, slug }));

      const removed = await tx.author.delete({ where: { id } });

      // 🔴 `LEGACY-400`, `T55b` (решение арбитра 27.09.2026): переводы уходят каскадом, а их `Seo`
      // (`AuthorTranslation.seoId` — `SetNull`) оставались сиротами; убираются, если больше ничьи.
      for (const row of dyingRows) {
        await deleteSeoIfUnreferenced(tx, row.seoId);
      }

      await this.adminAudit.record(tx, {
        action: AdminAuditAction.AUTHOR_DELETED,
        targetType: AdminAuditTargetType.AUTHOR,
        targetId: id,
        actorUserId,
        payload: { translations: dying },
      });

      return removed;
    }, AUTHOR_DELETE_TX_OPTIONS);
  }

  /**
   * Снятие моста `Author.personId` (`LEGACY-396`, решение арбитра 29.09.2026). Мост
   * присваивает только `ContributorsService.bridgeLegacyAuthor`, а снять его было нечем:
   * поля нет в `UpdateAuthorDto`, и удаление персоны с таким автором отказывало навсегда
   * (`PersonsService.remove`). Отдельная ручка, а не поле в DTO записи, — чтобы общий `PUT`
   * не мог тихо переписать мост на другую персону мимо `bridgeLegacyAuthor`.
   *
   * Строка автора запирается первым оператором транзакции (`FOR NO KEY UPDATE`, как
   * в `update`): встречная перестановка моста или удаление автора ждут замка, поэтому
   * ответ всегда согласован с записью — `personId: null` либо 404, а не «200 с чужим
   * мостом». Пишется ровно `personId: null`; на уже снятом мосту записи нет. Ответ тот же,
   * что у `update`: автор с переводами и их `Seo`. Журнал не пишется: правка автора
   * (`update`) его тоже не пишет (граница решения арбитра).
   */
  async unlinkPerson(id: string) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string; personId: string | null }[]>`
          SELECT id, "personId" FROM "Author" WHERE id = ${id} FOR NO KEY UPDATE`;
        if (locked.length === 0) {
          throw new NotFoundException(`Author with ID '${id}' not found`);
        }

        const include = { translations: { include: { seo: true } } };
        if (locked[0].personId !== null) {
          return toAdminAuthor(
            await tx.author.update({ where: { id }, data: { personId: null }, include }),
          );
        }

        return toAdminAuthor(await tx.author.findUniqueOrThrow({ where: { id }, include }));
      }, AUTHOR_UPDATE_TX_OPTIONS);
    } catch (error) {
      throw this.internalFailure('Failed to unlink author from person', error);
    }
  }

  async checkSlugExists(slug: string, language: Language, excludeId?: string) {
    const authorTrans = await this.prisma.authorTranslation.findFirst({
      where: this.buildTakenSlugWhere(slug, language, excludeId),
    });
    return authorTrans;
  }

  /**
   * Первый свободный слаг вида `<base>-2`, `<base>-3`, … в языке перевода (LEGACY-370).
   * Кандидаты проверяются пачками по точному списку: префиксный поиск тянул бы в память
   * всех однофамильцев (`ivan-bunin`, `ivan-turgenev`), ни один из которых ответом не станет.
   */
  async generateUniqueSuggestedSlug(
    baseSlug: string,
    language: Language,
    excludeId?: string,
  ): Promise<string> {
    for (let start = 2; ; start += SLUG_SUGGESTION_BATCH) {
      const candidates = Array.from({ length: SLUG_SUGGESTION_BATCH }, (_, i) =>
        suggestedSlugCandidate(baseSlug, start + i),
      );
      const taken = await this.prisma.authorTranslation.findMany({
        where: this.buildTakenSlugWhere({ in: candidates }, language, excludeId),
        select: { slug: true },
        take: SLUG_SUGGESTION_BATCH,
      });
      const takenSlugs = new Set(taken.map((row) => row.slug));
      const free = candidates.find((candidate) => !takenSlugs.has(candidate));
      if (free) {
        return free;
      }
    }
  }

  async getPublicBySlug(slug: string, language: Language) {
    // Find translation with matching slug and language
    const translation = await this.prisma.authorTranslation.findFirst({
      where: { slug, language },
      include: {
        seo: true,
        author: true,
      },
    });

    if (!translation) {
      throw new NotFoundException(
        `Author with slug '${slug}' for language '${language}' not found`,
      );
    }

    const author = translation.author;

    const faq = (translation.faq as unknown as AuthorFaq[]) || [];
    const similarSlugs = (translation.similarSlugs as unknown as string[]) || [];
    const blocks = readStoredBlocks(translation);

    // Порция 12 (F02-3); `booksTotal` и агрегаты шапки — по всему набору, а не по порции:
    // по порции они врут у автора с книгами за пределами первых 12 (решение арбитра
    // 14.10.2026, `F02 | F02-1`).
    const bookAuthor = { id: author.id, name: translation.name };
    const [{ entries, total }, aggregates, alternates, { books: bookRefs, authors: authorRefs }] =
      await Promise.all([
        this.getPublishedBookCards(bookAuthor, language, { take: AUTHOR_PAGE_BOOKS_FIRST }),
        this.getPublishedBooksAggregates(bookAuthor, language),
        this.getPublicAlternates(author.id),
        this.resolvePageRefs(blocks, similarSlugs, language),
      ]);
    const similarAuthors = this.toSimilarAuthors(similarSlugs, author.id, authorRefs);
    const book = (slug: string | null | undefined) => (slug ? (bookRefs.get(slug) ?? null) : null);
    const authorLink = (slug: string | null | undefined) => {
      const hit = slug ? authorRefs.get(slug) : undefined;
      // Ссылка на самого автора страницы в «Влияниях» — не ссылка.
      return hit?.slug && hit.authorId !== author.id ? { slug: hit.slug, name: hit.name } : null;
    };

    return {
      id: author.id,
      slug: translation.slug,
      birthDate: author.birthDate,
      deathDate: author.deathDate,
      nativeName: author.nativeName,
      photoCredit: author.photoCredit as unknown as AuthorPhotoCredit | null,
      wikidataUrl: translation.wikidataUrl,
      wikipediaUrl: translation.wikipediaUrl,
      photoUrl: translation.photoUrl,
      name: translation.name,
      tagline: blocks.tagline,
      biography: translation.biography,
      facts: blocks.facts,
      notableWorks: sortByYear(blocks.notableWorks ?? []).map((w) => ({
        ...w,
        book: book(w.bookSlug),
      })),
      // Не найденная на сайте книга из «С чего начать» отбрасывается: блок советует только
      // то, что можно открыть (`tech.md` §4).
      startHere: (blocks.startHere ?? []).flatMap((item) => {
        const card = book(item.bookSlug);
        return card ? [{ ...item, book: card }] : [];
      }),
      timeline: sortByYear(blocks.timeline ?? []).map((e) => ({ ...e, book: book(e.bookSlug) })),
      influences: blocks.influences
        ? {
            influencedBy: (blocks.influences.influencedBy ?? []).map((r) => ({
              ...r,
              author: authorLink(r.authorSlug),
            })),
            influenced: (blocks.influences.influenced ?? []).map((r) => ({
              ...r,
              author: authorLink(r.authorSlug),
            })),
          }
        : null,
      awards: sortByYear(blocks.awards ?? []),
      adaptations: sortByYear(blocks.adaptations ?? []).map((a) => ({
        ...a,
        book: book(a.bookSlug),
      })),
      funFacts: blocks.funFacts ?? [],
      sources: blocks.sources ?? [],
      quotes: (blocks.quotes ?? []).map((q) => ({ ...q, book: book(q.bookSlug) })),
      faq,
      updatedAt: translation.updatedAt,
      seo: translation.seo,
      alternates,
      similarAuthors,
      booksTotal: total,
      booksHasAudio: aggregates.hasAudio,
      booksAvgRating: aggregates.avgRating,
      books: entries.map((e) => ({ ...e.card, firstPublishedYear: e.firstPublishedYear })),
    };
  }

  /**
   * «Вводные для промпта» (решение арбитра 15.10.2026, `F02 | F02-2`): автор, его опубликованные
   * книги по языкам — тем же источником, что и страница (`getPublishedBookCards`: набор, порядок,
   * `hasAudio`), — и все авторы сайта со слагами по языкам, только `select` нужных полей.
   */
  async getPromptInputs(id: string) {
    const author = await this.prisma.author.findUnique({
      where: { id },
      select: {
        id: true,
        birthDate: true,
        deathDate: true,
        translations: {
          select: { language: true, name: true, slug: true },
          orderBy: { language: 'asc' },
        },
      },
    });
    if (!author) {
      throw new NotFoundException(`Author with ID '${id}' not found`);
    }

    const [books, rows] = await Promise.all([
      Promise.all(
        // Все пять языков, а не только переведённые: промпт заполняет все пять, и без списка
        // книг на языке модель не получит его слагов. Перевода нет — книги только по `authorId`.
        Object.values(Language).map(async (language) => {
          const own = author.translations.find((t) => t.language === language);
          const { entries, total } = await this.getPublishedBookCards(
            { id: author.id, name: own?.name ?? null },
            language,
            { take: AUTHOR_PAGE_BOOKS_CAP },
          );
          return {
            lang: language,
            items: entries.map((e) => ({
              title: e.card.title,
              slug: e.card.slug,
              firstPublishedYear: e.firstPublishedYear,
              hasAudio: e.card.hasAudio,
            })),
            total,
          };
        }),
      ),
      this.prisma.authorTranslation.findMany({
        select: { authorId: true, language: true, name: true, slug: true },
        orderBy: [{ authorId: 'asc' }, { language: 'asc' }],
        take: PROMPT_INPUT_AUTHOR_ROWS_CAP + 1,
      }),
    ]);

    const authorsTruncated = rows.length > PROMPT_INPUT_AUTHOR_ROWS_CAP;
    let kept = rows.slice(0, PROMPT_INPUT_AUTHOR_ROWS_CAP);
    if (authorsTruncated) {
      // Предел мог разрезать последнего автора по языкам — неполного автора не отдаём.
      const lastId = kept[kept.length - 1].authorId;
      kept = kept.filter((r) => r.authorId !== lastId);
    }
    const byAuthor = new Map<string, Array<{ lang: Language; name: string; slug: string }>>();
    for (const r of kept) {
      const names = byAuthor.get(r.authorId) ?? [];
      names.push({ lang: r.language, name: r.name, slug: r.slug });
      byAuthor.set(r.authorId, names);
    }
    const sortName = (names: Array<{ lang: Language; name: string }>) =>
      (names.find((n) => n.lang === Language.en) ?? names[0]).name;

    return {
      id: author.id,
      birthDate: author.birthDate,
      deathDate: author.deathDate,
      names: author.translations.map((t) => ({ lang: t.language, name: t.name, slug: t.slug })),
      books,
      authors: Array.from(byAuthor.values())
        .sort((a, b) => sortName(a).localeCompare(sortName(b), 'en'))
        .map((names) => ({ names })),
      authorsTruncated,
    };
  }

  /**
   * Автор по публичному слагу: сначала язык запроса, затем `en` — как искала догрузка
   * `/books/cards` до F02-1. Имя — перевода на языке запроса: по нему связаны книги,
   * у которых `authorId` пуст (`PUBLISHED_BOOKS_JOIN`); перевода нет — только `authorId`.
   */
  async resolvePublicAuthorRef(
    slug: string,
    language: Language,
  ): Promise<{ id: string; name: string | null } | null> {
    const hits = await this.prisma.authorTranslation.findMany({
      where: { slug, language: { in: [language, Language.en] } },
      select: { authorId: true, language: true, name: true },
    });
    const hit = hits.find((h) => h.language === language) ?? hits[0];
    if (!hit) return null;
    if (hit.language === language) return { id: hit.authorId, name: hit.name };

    const own = await this.prisma.authorTranslation.findFirst({
      where: { authorId: hit.authorId, language },
      select: { name: true },
    });
    return { id: hit.authorId, name: own?.name ?? null };
  }

  /**
   * Опубликованные книги автора на языке — **один источник** для страницы автора и для
   * `/books/cards` автора: условие, порядок, форма карточки и счёт (решение арбитра
   * 14.10.2026, `F02 | F02-1`). Разойдись они — догрузка отдала бы не те книги или
   * не в том порядке, а счётчик в шапке разошёлся бы со списком.
   *
   * Условие — `authorId` **или** имя перевода, как у хаба и карты сайта
   * (`PUBLISHED_BOOKS_JOIN`): только по `authorId` авторы, связанные с книгами лишь
   * по имени, получили бы ноль книг и `noindex`. Порядок — по году первой публикации,
   * книги без года в конце, затем название и `id` (стабильная пагинация).
   * `@@unique([bookId, language])` у `BookVersion` — одна строка на книгу, счёт строк
   * равен счёту книг.
   */
  async getPublishedBookCards(
    author: { id: string; name: string | null },
    language: Language,
    window: { skip?: number; take: number },
  ): Promise<{
    entries: Array<{ card: BookCardDto; firstPublishedYear: number | null }>;
    total: number;
  }> {
    const where = publishedAuthorBooksWhere(author, language);

    const [rows, total] = await Promise.all([
      this.prisma.bookVersion.findMany({
        where,
        select: { ...bookCardSelect(new Date()), firstPublishedYear: true },
        orderBy: [
          { firstPublishedYear: { sort: 'asc', nulls: 'last' } },
          { title: 'asc' },
          { id: 'asc' },
        ],
        skip: window.skip,
        take: window.take,
      }),
      this.prisma.bookVersion.count({ where }),
    ]);

    const linkedAuthorIds = rows.map((r) => r.authorId).filter((id): id is string => id !== null);
    const [ratings, slugs] = await Promise.all([
      loadBookCardRatings(
        this.prisma,
        rows.map((r) => r.bookId),
      ),
      this.getSlugsByAuthorIds(
        Array.from(new Set([author.id, ...linkedAuthorIds])).map((authorId) => ({
          authorId,
          language,
        })),
      ),
    ]);
    const ownSlug = slugs.get(authorSlugKey(author.id, language)) ?? null;

    return {
      entries: rows.map((r) => ({
        // Книга без `authorId` попала сюда по имени этого автора — ссылка на него же.
        card: toBookCardDto(
          r,
          ratings.get(r.bookId),
          r.authorId ? (slugs.get(authorSlugKey(r.authorId, language)) ?? null) : ownSlug,
        ),
        firstPublishedYear: r.firstPublishedYear,
      })),
      total,
    };
  }

  /**
   * Агрегаты шапки страницы автора по всему набору книг, а не по порции (F02-3):
   * есть ли книга с аудио — тем же признаком, что бейдж карточки (`audioChapters`,
   * `toBookCardDto`), — и средняя оценка: среднее средних по книгам с оценками, как
   * считала шапка по списку до порции. Оценки — одним `groupBy` с пределом строк.
   */
  private async getPublishedBooksAggregates(
    author: { id: string; name: string | null },
    language: Language,
  ): Promise<{ hasAudio: boolean; avgRating: number | null }> {
    const where = publishedAuthorBooksWhere(author, language);
    const [withAudio, ratings] = await Promise.all([
      this.prisma.bookVersion.findFirst({
        where: { ...where, audioChapters: { some: {} } },
        select: { id: true },
      }),
      this.prisma.bookRating.groupBy({
        by: ['bookId'],
        where: { book: { versions: { some: where } } },
        _avg: { score: true },
        orderBy: { bookId: 'asc' },
        take: AUTHOR_PAGE_BOOKS_CAP,
      }),
    ]);
    const averages = ratings
      .map((g) => g._avg?.score)
      .filter((avg): avg is number => typeof avg === 'number');
    return {
      hasAudio: withAudio !== null,
      avgRating:
        averages.length > 0 ? averages.reduce((sum, avg) => sum + avg, 0) / averages.length : null,
    };
  }

  /**
   * Переводы автора для `hreflang`: язык, слаг и индексируемость. Индексируемость —
   * по тому же правилу, что у карты сайта (`isAuthorLinkable` на фронте поверх
   * `booksCount` списка): опубликованных книг на языке перевода больше нуля, счёт —
   * через `PUBLISHED_BOOKS_JOIN`, как у списка.
   */
  private async getPublicAlternates(
    authorId: string,
  ): Promise<Array<{ lang: Language; slug: string; indexable: boolean }>> {
    const rows = await this.prisma.$queryRaw<
      Array<{ lang: Language; slug: string; booksCount: number }>
    >`
      SELECT t.language AS "lang", t.slug AS "slug", COUNT(DISTINCT bv."bookId")::int AS "booksCount"
      FROM "AuthorTranslation" t
      LEFT JOIN "BookVersion" bv ${PUBLISHED_BOOKS_JOIN}
      WHERE t."authorId" = ${authorId}
      GROUP BY t.language, t.slug
      ORDER BY t.language
    `;
    return rows.map((r) => ({ lang: r.lang, slug: r.slug, indexable: r.booksCount > 0 }));
  }

  /**
   * Похожие авторы по слагам из `similarSlugs` — слаг ищется на любом языке, а ссылка
   * ведёт на перевод того же автора **на языке страницы** (`tech.md` F02, T3). Раньше слаг
   * искался только на языке страницы, и английские слаги на русской странице давали
   * пустой блок.
   *
   * Автор нашёлся, но перевода на язык страницы нет — имя без ссылки (`slug: null`):
   * адреса на этом языке у него нет. Перевод есть, но опубликованных книг на этом языке
   * нет — тоже имя без ссылки: его страница закрыта `noindex` и в карту сайта не входит. Слаг не нашёлся вовсе — пропуск: показать нечего,
   * кроме самого слага. Порядок — как в `similarSlugs`; один автор — один раз; сам
   * автор страницы в свой блок не попадает.
   */
  private toSimilarAuthors(
    slugs: string[],
    selfAuthorId: string,
    resolved: Map<string, AuthorRef>,
  ): PublicSimilarAuthor[] {
    const wanted = slugs.slice(0, SIMILAR_AUTHORS_MAX);
    const seen = new Set<string>([selfAuthorId]);
    const result: PublicSimilarAuthor[] = [];
    for (const slug of wanted) {
      const hit = resolved.get(slug);
      if (!hit || seen.has(hit.authorId)) continue;
      seen.add(hit.authorId);
      result.push({
        name: hit.name,
        slug: hit.slug,
        photoUrl: hit.photoUrl,
        birthDate: hit.birthDate,
        deathDate: hit.deathDate,
      });
    }
    return result;
  }

  /**
   * Все ссылки из данных страницы на одном языке — **один путь** для публичной ручки и для
   * предупреждений сохранения (решение арбитра В4): тот же сбор слагов, тот же срез похожих
   * авторов, те же разрешители. Две копии этой цепочки уже расходились на срезах.
   * Книги — два запроса, авторы (похожие и влияния вместе) — три, на любое число слагов.
   */
  private async resolvePageRefs(
    blocks: StoredAuthorPageBlocks,
    similarSlugs: string[],
    language: Language,
  ): Promise<{
    refs: AuthorPageSlugRef[];
    books: Map<string, AuthorPageBookRef>;
    authors: Map<string, AuthorRef>;
  }> {
    const refs = collectSlugRefs(blocks, similarSlugs.slice(0, SIMILAR_AUTHORS_MAX));
    const [books, authors] = await Promise.all([
      this.resolveBookRefs(
        refs.filter((r) => r.kind === 'book').map((r) => r.slug),
        language,
      ),
      this.resolveAuthorRefs(
        refs.filter((r) => r.kind === 'author').map((r) => r.slug),
        language,
      ),
    ]);
    return { refs, books, authors };
  }

  /**
   * Авторы по слагам из данных страницы — `similarSlugs` и `influences[].authorSlug` — одним
   * разрешителем (`tech.md` F02, T2/T3): слаг ищется на любом языке, ссылка ведёт на перевод
   * того же автора **на языке страницы**. Три запроса на любое число слагов (без N+1).
   *
   * Перевода на языке страницы нет — имя найденного перевода и `slug: null`: адреса на этом
   * языке нет. Перевод есть, но опубликованных книг на языке нет — тоже `slug: null`: страница
   * закрыта `noindex` и в карту сайта не входит («ссылка = карта сайта = robots»). Слаг
   * не нашёлся вовсе — в результате его нет.
   */
  private async resolveAuthorRefs(
    slugs: string[],
    language: Language,
  ): Promise<Map<string, AuthorRef>> {
    const wanted = Array.from(new Set(slugs)).slice(0, AUTHOR_PAGE_REFS_MAX);
    if (wanted.length === 0) return new Map();
    // Пара `(language, slug)` в условии: уникальный индекс `@@unique([language, slug])`
    // начинается с языка, и без него поиск шёл бы мимо индекса.
    const matches = await this.prisma.authorTranslation.findMany({
      where: { language: { in: Object.values(Language) }, slug: { in: wanted } },
      select: {
        authorId: true,
        language: true,
        slug: true,
        name: true,
        photoUrl: true,
        author: { select: { birthDate: true, deathDate: true } },
      },
      // Слаг свободен в каждом языке отдельно: без порядка запасной выбор «первое совпадение»
      // менялся бы от запроса к запросу.
      orderBy: [{ language: 'asc' }, { authorId: 'asc' }],
    });
    const authorIds = Array.from(new Set(matches.map((m) => m.authorId)));
    const own =
      authorIds.length === 0
        ? []
        : await this.prisma.authorTranslation.findMany({
            where: { authorId: { in: authorIds }, language },
            select: { authorId: true, slug: true, name: true, photoUrl: true },
          });
    const ownByAuthor = new Map(own.map((o) => [o.authorId, o]));
    const linkable = await this.authorsWithPublishedBooks(
      own.map((o) => o.authorId),
      language,
    );

    const result = new Map<string, AuthorRef>();
    for (const slug of wanted) {
      const candidates = matches.filter((m) => m.slug === slug);
      const hit = candidates.find((m) => m.language === language) ?? candidates[0];
      if (!hit) continue;
      const inLang = ownByAuthor.get(hit.authorId);
      result.set(slug, {
        authorId: hit.authorId,
        name: inLang?.name ?? hit.name,
        slug: inLang && linkable.has(hit.authorId) ? inLang.slug : null,
        photoUrl: inLang?.photoUrl ?? hit.photoUrl,
        birthDate: hit.author.birthDate,
        deathDate: hit.author.deathDate,
      });
    }
    return result;
  }

  /**
   * Книги по слагам из данных страницы (`tech.md` F02, T2/T3): слаг ищется как слаг версии
   * на любом языке или как слаг книги; карточка — опубликованной версии **той же книги на
   * языке страницы**. Версии на языке нет или она не опубликована — слага в результате нет
   * (страница покажет название без ссылки). Два запроса на любое число слагов.
   */
  private async resolveBookRefs(
    slugs: string[],
    language: Language,
  ): Promise<Map<string, AuthorPageBookRef>> {
    const wanted = Array.from(new Set(slugs)).slice(0, AUTHOR_PAGE_REFS_MAX);
    if (wanted.length === 0) return new Map();
    const matches = await this.prisma.bookVersion.findMany({
      // Язык в паре со слагом — по уникальному индексу `@@unique([language, slug])`: без него
      // левая половина `OR` шла бы полным проходом по `BookVersion` (`LEGACY-272`).
      where: {
        OR: [
          {
            language: { in: Object.values(Language) },
            slug: { in: wanted },
            status: 'published',
          },
          { book: { slug: { in: wanted } } },
        ],
      },
      select: {
        bookId: true,
        language: true,
        slug: true,
        status: true,
        book: { select: { slug: true } },
      },
      orderBy: [{ language: 'asc' }, { id: 'asc' }],
      // Слаг версии уникален в языке, слаг книги — глобально: на слаг не больше версии
      // на каждый язык по каждому из двух путей.
      take: wanted.length * Object.values(Language).length * 2,
    });
    const bookIdBySlug = new Map<string, string>();
    for (const slug of wanted) {
      // Порядок — как у адреса книги (`BookService.getOverview`): опубликованная версия с этим
      // слагом на языке страницы, затем опубликованная на любом языке, затем `Book.slug`.
      // Черновик слаг не занимает: иначе ссылка вела бы не туда, куда открывается адрес.
      const byVersion = matches.filter((m) => m.slug === slug && m.status === 'published');
      const hit = pickSlugOwner(byVersion, language) ?? matches.find((m) => m.book.slug === slug);
      if (hit) bookIdBySlug.set(slug, hit.bookId);
    }
    const bookIds = Array.from(new Set(bookIdBySlug.values()));
    if (bookIds.length === 0) return new Map();

    const versions = await this.prisma.bookVersion.findMany({
      where: { bookId: { in: bookIds }, language, status: 'published' },
      select: {
        bookId: true,
        slug: true,
        title: true,
        coverImageUrl: true,
        book: { select: { slug: true } },
      },
    });
    const cardByBook = new Map(
      versions.map((v) => [
        v.bookId,
        // Версия без своего слага ведёт на слаг книги — то же правило, что у карточки.
        { slug: bookCardSlug(v), title: v.title, coverUrl: v.coverImageUrl },
      ]),
    );
    const result = new Map<string, AuthorPageBookRef>();
    for (const [slug, bookId] of bookIdBySlug) {
      const card = cardByBook.get(bookId);
      if (card) result.set(slug, card);
    }
    return result;
  }

  /**
   * Предупреждения сохранения (решение арбитра 15.10.2026, `F02 | F02-2`): слаги книг
   * и авторов в данных автора, которые страница покажет без ссылки. Считает тем же
   * разрешителем, что и публичная ручка, по каждому языку; сохранение не отклоняет.
   * Сбой подсчёта — `null`, а не `[]`: пустой список значил бы «всё найдено».
   */
  private async computeSlugWarnings(authorId: string): Promise<AuthorSlugWarning[] | null> {
    try {
      const translations = await this.prisma.authorTranslation.findMany({
        where: { authorId },
        select: {
          language: true,
          similarSlugs: true,
          // Блоки со слагами — тем же списком, что читает `collectSlugRefs`.
          ...Object.fromEntries(SLUG_REF_BLOCK_KEYS.map((key) => [key, true])),
        } as Prisma.AuthorTranslationSelect &
          Record<SlugRefBlockKey | 'language' | 'similarSlugs', true>,
        orderBy: { language: 'asc' },
      });
      const perLanguage = await Promise.all(
        translations.map(async (t) => {
          const { refs, books, authors } = await this.resolvePageRefs(
            readStoredBlocks(t),
            (t.similarSlugs as unknown as string[] | null) ?? [],
            t.language,
          );
          return refs
            .filter((r) => (r.kind === 'book' ? !books.has(r.slug) : !authors.get(r.slug)?.slug))
            .map((r) => ({ lang: t.language, path: r.path, slug: r.slug }));
        }),
      );
      return perLanguage.flat();
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(AuthorService.describeCause(error));
      this.logger.warn(`Failed to compute author slug warnings: ${cause.message}`);
      return null;
    }
  }

  /**
   * Кто из авторов линкуем на языке — опубликованных книг на нём больше нуля, счёт тот же,
   * что у списка и карты сайта (`PUBLISHED_BOOKS_JOIN`).
   */
  private async authorsWithPublishedBooks(
    authorIds: string[],
    language: Language,
  ): Promise<Set<string>> {
    if (authorIds.length === 0) return new Set();
    const rows = await this.prisma.$queryRaw<Array<{ authorId: string }>>`
      SELECT t."authorId" AS "authorId"
      FROM "AuthorTranslation" t
      JOIN "BookVersion" bv ${PUBLISHED_BOOKS_JOIN}
      WHERE t.language = ${language}::"Language" AND t."authorId" IN (${Prisma.join(authorIds)})
      GROUP BY t."authorId"
    `;
    return new Set(rows.map((r) => r.authorId));
  }

  /**
   * Ответ на неожиданный отказ базы в `create` и `update` (`LEGACY-196`).
   *
   * 🔴 Раньше здесь стояло `new BadRequestException('Failed to …: ' + error.message)`,
   * и это было неверно дважды. Текст драйвера Prisma — с именем модели, именем
   * колонки и текстом ограничения — уходил клиенту прямо в поле `message`,
   * мимо сторожа `book.controller.errors.spec.ts`: тот ищет имя поля `details`.
   * А статус 400 говорил «клиент прислал плохой запрос» про отказ базы, из-за
   * чего падение вообще не попадало в алерты: `SentryExceptionFilter` шлёт
   * в Sentry только 5xx.
   *
   * ⚠️ Диагностика не теряется в двух местах сразу, и оба обязательны. В лог
   * идут текст и стек. В `cause` идёт само исходное исключение: без него
   * `Sentry.captureException` получит фразу-заглушку со стеком этого метода,
   * и десять разных отказов станут в Sentry одним.
   *
   * ⚠️ Проверки данных (занятый слаг, отсутствующий автор) стоят **выше**
   * `try` и сюда не попадают — их 400 и 404 остаются как были. Пропуск
   * `HttpException` насквозь страхует от того, что кто-то занесёт такую
   * проверку внутрь блока.
   */
  private internalFailure(message: string, err: unknown): HttpException {
    if (err instanceof HttpException) return err;

    // 🔴 Нарушенное уникальное ограничение — ошибка ввода, а не сбой сервера,
    // и 500 здесь был бы той же подменой статуса, ради снятия которой запись
    // и заводилась (`STYLE_GUIDE.md` §8: `P2002` → 409). Предпроверка слага
    // выше по методу ловит `@@unique([language, slug])`, но не
    // `@@unique([authorId, language])`: два перевода одного языка в одном теле
    // до базы доходят. Текст драйвера наружу не идёт и здесь — только код
    // и фраза; сам текст остаётся в журнале.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      this.logger.warn(`${message}: unique constraint violated — ${err.message}`);
      return new ConflictException(
        'Author translation already exists for one of the requested languages',
      );
    }

    // Отказ не-`Error` объектом (например, `Promise.reject({ code: 'P2024' })`)
    // иначе превращается в `[object Object]` и не оставляет ничего нигде.
    const cause = err instanceof Error ? err : new Error(AuthorService.describeCause(err));
    this.logger.error(`${message}: ${cause.message}`, cause.stack);
    return new HttpException({ message }, HttpStatus.INTERNAL_SERVER_ERROR, { cause });
  }

  private static describeCause(err: unknown): string {
    if (typeof err === 'string') return err;
    try {
      return JSON.stringify(err) ?? String(err);
    } catch {
      // Циклическая ссылка в отброшенном объекте.
      return String(err);
    }
  }

  /** Условие «слаг занят» — одно на проверку и на подсказку (LEGACY-215, LEGACY-370). */
  private buildTakenSlugWhere(
    slug: string | Prisma.StringFilter,
    language: Language,
    excludeId?: string,
  ): Prisma.AuthorTranslationWhereInput {
    const where: Prisma.AuthorTranslationWhereInput = { slug, language };
    if (excludeId) {
      where.NOT = { authorId: excludeId };
    }
    return where;
  }
}

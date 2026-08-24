import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateAuthorDto } from './dto/create-author.dto';
import { UpdateAuthorDto } from './dto/update-author.dto';
import { Language, Prisma } from '@prisma/client';
import {
  AuthorQuoteDto as AuthorQuote,
  AuthorFaqDto as AuthorFaq,
} from './dto/author-translation.dto';
import { SlugRedirectService } from '../slug-redirect/slug-redirect.service';
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
  INDEX_LETTER_SQL,
  OTHER_LETTER,
  SHORT_BIO_SOURCE_LIMIT,
  alphabetForLanguage,
  buildShortBio,
  isKnownLetter,
  letterCondition,
  sortLetters,
} from './author-index.util';

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

/** Пагинация публичного списка. `limit` — применённый, а не запрошенный. */
export interface PublicAuthorsListMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Связь автора с опубликованными книгами — одной формулой на все запросы.
 *
 * 🔴 Формула хрупкая и неочевидная, поэтому существует ровно один её экземпляр.
 * Строгая FK `BookVersion.authorId` в проде NULL у всех опубликованных версий,
 * и фактический источник истины — совпадение по имени внутри своего языка
 * (в ru-версии книги автор записан как «Сунь-цзы», сверять его с английским
 * «Sun Tzu» бессмысленно). Три места считают по ней: счётчик книг, публичный
 * список и ручка букв. Разъедься они — счётчик на карточке, число под буквой
 * и `noindex` на странице автора начали бы отвечать по-разному, и заметить это
 * можно было бы только глазами.
 */
const PUBLISHED_BOOKS_JOIN = Prisma.sql`
  ON bv.language = t.language
 AND bv.status = 'published'
 AND (bv."authorId" = t."authorId" OR bv.author = t.name)`;

@Injectable()
export class AuthorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly slugRedirects: SlugRedirectService,
  ) {}

  /**
   * Сколько **опубликованных книг** у каждого из авторов — батчем.
   *
   * 🔴 Считать по внешнему ключу `BookVersion.authorId`, как было до 09.08.2026,
   * нельзя: в проде он NULL у всех опубликованных версий, и `_count.bookVersions`
   * давал ноль **всем десяти** авторам, включая тех, чьи книги лежат в каталоге.
   * Фактическая связь держится на строковом поле `BookVersion.author`.
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
  private async countPublishedBooksByAuthor(
    authorIds: string[],
    lang?: Language,
  ): Promise<Map<string, number>> {
    if (authorIds.length === 0) return new Map();

    const conditions: Prisma.Sql[] = [Prisma.sql`t."authorId" IN (${Prisma.join(authorIds)})`];
    if (lang) {
      conditions.push(Prisma.sql`t.language = ${lang}::"Language"`);
    }

    const rows = await this.prisma.$queryRaw<Array<{ authorId: string; booksCount: number }>>`
      SELECT t."authorId", COUNT(DISTINCT bv."bookId")::int AS "booksCount"
      FROM "AuthorTranslation" t
      JOIN "BookVersion" bv ${PUBLISHED_BOOKS_JOIN}
      WHERE ${Prisma.join(conditions, ' AND ')}
      GROUP BY t."authorId"
    `;

    return new Map(rows.map((r) => [r.authorId, r.booksCount]));
  }

  /**
   * @param lang Язык публичного списка. Когда задан, автор без перевода на него
   * из выдачи исключается: страницы на этом языке у него нет вовсе, и ссылка
   * вела бы в 404 (soft-404 закрыт 05.08.2026). Админский список ходит без
   * языка и видит всех.
   */
  async list(page = 1, limit = 20, lang?: Language) {
    const skip = (page - 1) * limit;
    const where: Prisma.AuthorWhereInput | undefined = lang
      ? { translations: { some: { language: lang } } }
      : undefined;

    const [total, items] = await this.prisma.$transaction([
      this.prisma.author.count({ where }),
      this.prisma.author.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          translations: {
            include: { seo: true },
          },
        },
      }),
    ]);

    const booksCounts = await this.countPublishedBooksByAuthor(
      items.map((item) => item.id),
      lang,
    );

    return {
      data: items.map((item) => {
        // С языком — перевод на него (он гарантированно есть, список по нему и
        // отфильтрован). Без языка это админская выдача, там прежний порядок:
        // английский, иначе первый попавшийся.
        const mainTrans = lang
          ? item.translations.find((t) => t.language === lang)
          : item.translations.find((t) => t.language === 'en') || item.translations[0];

        return {
          id: item.id,
          slug: mainTrans?.slug || '',
          name: mainTrans?.name || '',
          birthDate: item.birthDate,
          deathDate: item.deathDate,
          wikidataUrl: mainTrans?.wikidataUrl || null,
          wikipediaUrl: mainTrans?.wikipediaUrl || null,
          photoUrl: mainTrans?.photoUrl || null,
          translations: item.translations,
          booksCount: booksCounts.get(item.id) ?? 0,
        };
      }),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
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
  ): Promise<{ data: PublicAuthorListItem[]; meta: PublicAuthorsListMeta }> {
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
    const meta = { page, limit, total, totalPages: Math.ceil(total / limit) };

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
      const escaped = term.replace(/([\\%_])/g, '\\$1');
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

    try {
      return await this.prisma.author.create({
        data: {
          birthDate: dto.birthDate,
          deathDate: dto.deathDate,
          translations: {
            create: dto.translations.map((t) => ({
              language: t.language,
              slug: t.slug,
              name: t.name,
              biography: t.biography,
              wikidataUrl: t.wikidataUrl,
              wikipediaUrl: t.wikipediaUrl,
              photoUrl: t.photoUrl || syncedPhotoUrl,
              quotes: t.quotes as unknown as Prisma.InputJsonValue,
              faq: t.faq as unknown as Prisma.InputJsonValue,
              similarSlugs: t.similarSlugs as unknown as Prisma.InputJsonValue,
              seo: t.seo
                ? {
                    create: {
                      metaTitle: t.seo.metaTitle,
                      metaDescription: t.seo.metaDescription,
                      canonicalUrl: t.seo.canonicalUrl,
                      robots: t.seo.robots,
                      ogTitle: t.seo.ogTitle,
                      ogDescription: t.seo.ogDescription,
                      ogImageUrl: t.seo.ogImageUrl,
                      ogImageAlt: t.seo.ogImageAlt,
                      twitterCard: t.seo.twitterCard,
                    },
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
      throw new BadRequestException('Failed to create author: ' + (error as Error).message);
    }
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

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Update main fields
        await tx.author.update({
          where: { id },
          data: {
            birthDate: dto.birthDate,
            deathDate: dto.deathDate,
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
            select: { seoId: true, photoUrl: true, language: true, slug: true },
          });
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

          // Clean up old Seo records
          if (seoIdsToDelete.length > 0) {
            await tx.seo.deleteMany({ where: { id: { in: seoIdsToDelete } } });
          }

          // Re-create translations
          for (const t of dto.translations) {
            await tx.authorTranslation.create({
              data: {
                author: { connect: { id } },
                language: t.language,
                slug: t.slug,
                name: t.name,
                biography: t.biography,
                wikidataUrl: t.wikidataUrl,
                wikipediaUrl: t.wikipediaUrl,
                photoUrl: t.photoUrl || finalPhoto,
                quotes: t.quotes as unknown as Prisma.InputJsonValue,
                faq: t.faq as unknown as Prisma.InputJsonValue,
                similarSlugs: t.similarSlugs as unknown as Prisma.InputJsonValue,
                seo: t.seo
                  ? {
                      create: {
                        metaTitle: t.seo.metaTitle,
                        metaDescription: t.seo.metaDescription,
                        canonicalUrl: t.seo.canonicalUrl,
                        robots: t.seo.robots,
                        ogTitle: t.seo.ogTitle,
                        ogDescription: t.seo.ogDescription,
                        ogImageUrl: t.seo.ogImageUrl,
                        ogImageAlt: t.seo.ogImageAlt,
                        twitterCard: t.seo.twitterCard,
                      },
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
      });
    } catch (error) {
      throw new BadRequestException('Failed to update author: ' + (error as Error).message);
    }
  }

  async delete(id: string) {
    const author = await this.prisma.author.findUnique({ where: { id } });
    if (!author) {
      throw new NotFoundException(`Author with ID '${id}' not found`);
    }
    return this.prisma.author.delete({ where: { id } });
  }

  async checkSlugExists(slug: string, excludeId?: string) {
    const where: Prisma.AuthorTranslationWhereInput = { slug };
    if (excludeId) {
      where.NOT = { authorId: excludeId };
    }
    const authorTrans = await this.prisma.authorTranslation.findFirst({ where });
    return authorTrans;
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

    const quotes = (translation.quotes as unknown as AuthorQuote[]) || [];
    const faq = (translation.faq as unknown as AuthorFaq[]) || [];
    let similarAuthors: { name: string; slug: string }[] = [];
    const similarSlugs = (translation.similarSlugs as unknown as string[]) || [];
    if (similarSlugs.length > 0) {
      const dbSimilar = await this.prisma.authorTranslation.findMany({
        where: { slug: { in: similarSlugs }, language },
        select: { name: true, slug: true },
      });
      similarAuthors = dbSimilar.map((sa) => ({
        slug: sa.slug,
        name: sa.name,
      }));
    }

    // Get books by this author
    // Fallback: match by authorId OR by string match of author's name
    const bookVersions = await this.prisma.bookVersion.findMany({
      where: {
        language,
        status: 'published',
        OR: [{ authorId: author.id }, { author: translation.name }],
      },
      include: {
        book: {
          select: {
            id: true,
            slug: true,
          },
        },
      },
      orderBy: { publishedAt: 'desc' },
    });

    return {
      id: author.id,
      slug: translation.slug,
      birthDate: author.birthDate,
      deathDate: author.deathDate,
      wikidataUrl: translation.wikidataUrl,
      wikipediaUrl: translation.wikipediaUrl,
      photoUrl: translation.photoUrl,
      name: translation.name,
      biography: translation.biography,
      quotes,
      faq,
      seo: translation.seo,
      similarAuthors,
      books: await Promise.all(
        bookVersions.map(async (bv) => {
          const agg = await this.prisma.bookRating.aggregate({
            where: { bookId: bv.bookId },
            _avg: { score: true },
          });
          return {
            id: bv.id,
            bookId: bv.bookId,
            slug: bv.slug || bv.book.slug,
            title: bv.title,
            author: bv.author,
            coverImageUrl: bv.coverImageUrl,
            coverUrl: bv.coverImageUrl,
            type: bv.type,
            isFree: bv.isFree,
            rating: agg._avg.score ?? null,
            versions: [
              {
                language: bv.language,
                status: bv.status,
                type: bv.type,
                coverImageUrl: bv.coverImageUrl,
                coverUrl: bv.coverImageUrl,
              },
            ],
          };
        }),
      ),
    };
  }
}

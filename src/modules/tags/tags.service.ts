import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma, Language, Tag, TagTranslation } from '@prisma/client';
import {
  PUBLIC_BOOK_VERSION_SELECT,
  type PublicBookVersion,
} from '../../common/selects/public-book.select';
import { PrismaService } from '../../prisma/prisma.service';
import { TaxonomyIndexabilityService } from '../seo/indexability/taxonomy-indexability.service';
import { SlugRedirectService } from '../slug-redirect/slug-redirect.service';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';
import { PUBLIC_TAG_BOOKS_MAX_LIMIT } from './tag-books-listing.constants';
import { CreateTagTranslationDto } from './dto/create-tag-translation.dto';
import { UpdateTagTranslationDto } from './dto/update-tag-translation.dto';
import { TAG_TX_OPTIONS, TagLockService } from './tag-lock.service';
import { getSupportedLanguages } from '../../shared/language/language.util';

@Injectable()
export class TagsService {
  constructor(
    private prisma: PrismaService,
    private readonly slugRedirects: SlugRedirectService,
    private readonly tagLock: TagLockService,
    @Optional()
    private readonly taxonomyIndexabilityService?: TaxonomyIndexabilityService,
  ) {}

  async list(page = 1, limit = 20, search?: string, lang?: Language) {
    const skip = (page - 1) * limit;
    const where: Prisma.TagWhereInput = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { slug: { contains: search, mode: 'insensitive' } },
            { translations: { some: { name: { contains: search, mode: 'insensitive' } } } },
          ],
        }
      : {};

    const [total, items] = await this.prisma.$transaction([
      this.prisma.tag.count({ where }),
      this.prisma.tag.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        skip,
        take: limit,
        include: {
          translations: {
            select: {
              language: true,
              name: true,
              slug: true,
              description: true,
              relatedTagSlugs: true,
              relatedGenreSlugs: true,
              relatedCategorySlugs: true,
              relatedCollectionSlugs: true,
              bookCount: true,
              autoIndexable: true,
            },
          },
        },
      }),
    ]);

    // Count distinct books per tag (via bookId, not BookVersion), optionally filtered by language
    const tagIds = items.map((item) => item.id);

    // 🔴 Проверка `tagIds.length > 0` ниже, на самом `$queryRaw`, не спасала:
    // `Prisma.join([])` бросает TypeError уже при сборке условия, то есть строкой
    // выше. См. `CategoryService.list` — тот же дефект, тот же ранний выход.
    if (tagIds.length === 0) {
      return {
        data: [],
        meta: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    }

    const tagWhereConditions: Prisma.Sql[] = [
      Prisma.sql`bt."tagId" IN (${Prisma.join(tagIds)})`,
      Prisma.sql`bv.status = 'published'`,
    ];
    if (lang) {
      tagWhereConditions.push(Prisma.sql`bv.language = ${lang}::"Language"`);
    }
    const bookCounts = await this.prisma.$queryRaw<Array<{ tagId: string; booksCount: number }>>`
      SELECT bt."tagId", COUNT(DISTINCT bv."bookId")::int as "booksCount"
      FROM "BookTag" bt
      JOIN "BookVersion" bv ON bt."bookVersionId" = bv.id
      WHERE ${Prisma.join(tagWhereConditions, ' AND ')}
      GROUP BY bt."tagId"
    `;
    const countMap = new Map(bookCounts.map((row) => [row.tagId, row.booksCount]));

    const data = items.map((item) => {
      // Project the requested language's indexability signals onto the tag.
      // No lang, or no translation for it → both stay undefined, never a value
      // borrowed from an arbitrary other language.
      const langTranslation = lang ? item.translations.find((t) => t.language === lang) : undefined;

      return {
        id: item.id,
        name: item.name,
        slug: item.slug,
        key: item.key,
        indexable: item.indexable ?? true,
        isVisible: item.isVisible ?? true,
        sortOrder: item.sortOrder ?? 0,
        translations: item.translations,
        booksCount: countMap.get(item.id) || 0,
        langBookCount: langTranslation?.bookCount,
        autoIndexable: langTranslation?.autoIndexable,
      };
    });

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * `LEGACY-320`. Создание берёт замок ключа: иначе импорт того же `key`,
   * не нашедший строки на пробе, видел её следующим чтением и шёл веткой
   * обновления по строке, которую не запирал.
   */
  async create(dto: CreateTagDto) {
    const key = dto.key || dto.slug;
    return this.tagLock.runInLockedTag({ key }, (tx) =>
      tx.tag.create({
        data: {
          name: dto.name,
          slug: dto.slug,
          key,
          ...(dto.indexable !== undefined ? { indexable: dto.indexable } : {}),
          ...(dto.isVisible !== undefined ? { isVisible: dto.isVisible } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        },
      }),
    );
  }

  /**
   * 🔴 `LEGACY-320`. Строка тега запирается первым оператором транзакции,
   * и **всё** решается уже под замком: прежде `exists` читался на клиенте пула,
   * а по нему считались и проверка неизменяемости `key`, и решение писать
   * историю базового слага. Между тем чтением и записью помещался встречный
   * импорт того же ключа — и редирект уходил со слага, которого в базе уже нет.
   *
   * ⚠️ Границы транзакции — явные (`TAG_TX_OPTIONS`), а не дефолтные. Голая
   * `$transaction` даёт дедлайн 5 секунд, и писатель, дождавшийся своей очереди
   * на замке, отдал бы `P2028` и 500 вместо ответа (`L-020`).
   *
   * ⚠️ Проверка существования не переехала «заодно»: она обязана быть внутри —
   * между чтением на пуле и записью термин мог быть удалён, и тогда `update`
   * падал `P2025` вместо 404.
   */
  async update(id: string, dto: UpdateTagDto) {
    return this.tagLock.runInLockedTag({ id }, async (tx) => {
      const exists = await tx.tag.findUnique({ where: { id } });
      if (!exists) throw new NotFoundException('Tag not found');

      // См. `CategoryService.update`: `key` — единственный неизменяемый ключ
      // термина, по нему связывает JSON-импорт, и уехавший ключ даёт не ошибку, а
      // дубликат. Совпадающее значение пропускается: админка шлёт его в каждом PATCH.
      if (dto.key !== undefined && dto.key !== exists.key) {
        throw new BadRequestException(
          `Tag key is immutable: it is the only stable identifier of the term. ` +
            `Attempted to change "${exists.key}" to "${dto.key}".`,
        );
      }
      // См. категории: базовый слаг — фолбэк резолва, его смена ломает все языки.
      const baseSlugChanged = !!dto.slug && dto.slug !== exists.slug;

      if (baseSlugChanged && dto.slug) {
        await this.slugRedirects.recordBaseSlugChange('tag', exists.slug, dto.slug, tx);
      }

      return tx.tag.update({
        where: { id },
        data: {
          name: dto.name,
          slug: dto.slug,
          // `key` намеренно отсутствует — он неизменяем; прежняя ветка
          // `dto.slug -> key` молча делала слаг ключом при PATCH без `key`.
          ...(dto.indexable !== undefined ? { indexable: dto.indexable } : {}),
          ...(dto.isVisible !== undefined ? { isVisible: dto.isVisible } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        },
      });
    });
  }

  /**
   * `LEGACY-395`. Уборка истории слагов повторяет `CategoryService.remove`
   * (`LEGACY-390`/`LEGACY-394`) один в один по форме — у тега та же пара
   * базовый слаг + переводы по языкам, — с одной разницей: у тега нет
   * родителя, преемника редиректу писать некуда, поэтому шага, аналогичного
   * `retireCategoryAddress`, здесь только половина — сама уборка, без записи
   * нового звена цепочки.
   */
  async remove(id: string) {
    return this.tagLock.runInLockedTag({ id }, async (tx) => {
      const exists = await tx.tag.findUnique({ where: { id } });
      if (!exists) throw new NotFoundException('Tag not found');

      // Умирающие переводы читаются до удаления: после `deleteMany` взять их
      // слаги уже неоткуда.
      const dying = await tx.tagTranslation.findMany({
        where: { tagId: id },
        select: { language: true, slug: true },
      });

      await tx.bookTag.deleteMany({ where: { tagId: id } });
      await tx.tagTranslation.deleteMany({ where: { tagId: id } });

      const removed = await tx.tag.delete({ where: { id } });

      for (const dyingTranslation of dying) {
        // Адрес пережил удаление, если слаг перевода совпал с чьим-то ещё
        // живым базовым слагом (`versionsByTagLangSlug` фоллбэком найдёт его) —
        // тогда снимать записи, ведущие на него, нельзя: они по-прежнему верны.
        const takenAsBase = await this.isTagBaseSlugTaken(tx, dyingTranslation.slug);
        if (!takenAsBase) {
          await this.slugRedirects.cleanupDeadRedirects(
            'tag',
            [dyingTranslation.language],
            dyingTranslation.slug,
            tx,
          );
        }
      }

      // Базовый слаг тоже умер — живость решается по языкам (`LEGACY-394`),
      // как и у категории.
      const deadLanguages = await this.deadLanguagesForTagSlug(tx, removed.slug);
      if (deadLanguages.length > 0) {
        await this.slugRedirects.cleanupDeadRedirects('tag', deadLanguages, removed.slug, tx);
      }

      return removed;
    });
  }

  /**
   * Держит ли слаг чей-то живой базовый `Tag.slug` (см.
   * `CategoryService.isBaseSlugTaken`, тот же вопрос для категорий). Тег,
   * о который спотыкаются здесь, к этому моменту уже удалён — исключать
   * себя не из чего.
   *
   * 🔴 `isVisible: true` — находка ревью, дефект внесён этим же заходом
   * и починен здесь же: резолвер (`versionsByTagLangSlug`, фоллбэк на базовый
   * слаг) сам берёт только `tag.findFirst({slug, isVisible: true})` — скрытый
   * тег адрес не оживляет, и без этого условия здесь уборка ошибочно
   * пропускалась бы на слаге, который публично уже 404.
   */
  private async isTagBaseSlugTaken(tx: Prisma.TransactionClient, slug: string): Promise<boolean> {
    const taken = await tx.tag.findFirst({
      where: { slug, isVisible: true },
      select: { id: true },
    });
    return !!taken;
  }

  /**
   * Языки, в которых адрес по этому слагу (бывшему базовому слагу удалённого
   * тега) мёртв (см. `CategoryService.deadLanguagesForSlug`, `LEGACY-394`):
   * базовый `Tag.slug` живого тега оживляет адрес во всех языках сразу
   * (`versionsByTagLangSlug` при промахе перевода падает на `tag.findFirst({slug})`
   * без учёта языка), слаг перевода — только в своём.
   *
   * 🔴 `tag: { isVisible: true }` — та же находка, что у `isTagBaseSlugTaken`:
   * резолвер принимает перевод только когда `trans.tag.isVisible !== false`
   * (`versionsByTagLangSlug:229`), а `isVisible` в схеме не бывает `null`
   * (`Boolean @default(true)`), так что это ровно `isVisible === true`.
   */
  private async deadLanguagesForTagSlug(
    tx: Prisma.TransactionClient,
    slug: string,
  ): Promise<Language[]> {
    if (await this.isTagBaseSlugTaken(tx, slug)) return [];

    const languages = getSupportedLanguages();
    const liveTranslations = await tx.tagTranslation.findMany({
      where: { slug, language: { in: languages }, tag: { isVisible: true } },
      select: { language: true },
      take: languages.length,
    });
    const live = new Set(liveTranslations.map((t) => t.language));
    return languages.filter((language) => !live.has(language));
  }

  async versionsByTagLangSlug(
    pathLang: Language,
    slug: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<{
    tag: Tag & { translation: TagTranslation | null; description: string | null };
    seo: Record<string, unknown> | null;
    data: (PublicBookVersion & {
      rating: number | null;
      seo: { metaTitle: string | null; metaDescription: string | null } | null;
    })[];
    meta: { page: number; limit: number; total: number; totalPages: number };
    availableLanguages: Language[];
  }> {
    const trans = await this.prisma.tagTranslation.findUnique({
      where: { language_slug: { language: pathLang, slug } },
      include: { tag: true, seo: true },
    });
    let tagId: string | null = null;
    let baseTag: Tag | null = null;
    if (trans?.tag && trans.tag.isVisible !== false) {
      baseTag = trans.tag;
      tagId = trans.tag.id;
    } else {
      // Fallback to base Tag by slug for backward compatibility
      const found = await this.prisma.tag.findFirst({
        where: { slug, isVisible: true },
      });
      if (!found) throw new NotFoundException('Tag not found');
      tagId = found.id;
      baseTag = found;
    }
    // Второй рубеж после `PublicTagBooksQueryDto` (`LEGACY-199`), по образцу
    // `PUBLIC_AUTHORS_MAX_LIMIT`: DTO стережёт только вход через контроллер, а метод
    // публичный, и второй его зов - из кода, из админского пути, из копии соседнего
    // маршрута - ушёл бы в `skip`/`take` с чем угодно. Значения по умолчанию
    // в сигнатуре от этого не спасают: они срабатывают только на `undefined`.
    const effectiveLimit = Math.min(
      Math.max(Math.trunc(limit) || 1, 1),
      PUBLIC_TAG_BOOKS_MAX_LIMIT,
    );
    const effectivePage = Math.max(Math.trunc(page) || 1, 1);

    const where = {
      status: 'published' as const,
      language: pathLang,
      tags: { some: { tagId } },
    };
    const skip = (effectivePage - 1) * effectiveLimit;
    // `total` считается до страницы (`LEGACY-301`), по образцу `BookService.findCards`:
    // `?page=1000000` заставлял базу отсортировать всю выдачу тега и отбросить её
    // целиком — `LIMIT/OFFSET` режет страницу после сортировки, поэтому стоимость
    // не падала с ростом `page`. Страница за пределами выдачи в базу за ней не идёт,
    // ответ не меняется: пустой список и честный `total`.
    const total = await this.prisma.bookVersion.count({ where });
    const versions =
      skip >= total
        ? []
        : await this.prisma.bookVersion.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: effectiveLimit,
            select: {
              ...PUBLIC_BOOK_VERSION_SELECT,
              seo: { select: { metaTitle: true, metaDescription: true } },
            },
          });
    const availableLanguages: Language[] = Array.from(
      new Set(
        (
          await this.prisma.bookVersion.findMany({
            where: { status: 'published', tags: { some: { tagId } } },
            select: { language: true },
          })
        ).map((v) => v.language),
      ),
    );
    const bookIds = [...new Set(versions.map((v) => v.bookId))];
    const ratings = await this.prisma.bookRating.groupBy({
      by: ['bookId'],
      where: { bookId: { in: bookIds } },
      _avg: { score: true },
    });
    const ratingMap = new Map(ratings.map((r) => [r.bookId, r._avg.score]));
    const data = versions.map((v) => ({
      ...v,
      rating: ratingMap.get(v.bookId) ?? null,
    }));

    return {
      tag: {
        ...baseTag,
        translation: (trans as TagTranslation) ?? null,
        description: trans?.description ?? null,
      },
      seo: trans?.seo ?? null,
      data,
      // `meta` собирается из **применённых** значений, а не из запрошенных: потребитель
      // делит `total` на `meta.limit`, и при расхождении получает неверное число страниц,
      // не узнав об этом.
      meta: {
        page: effectivePage,
        limit: effectiveLimit,
        total,
        totalPages: Math.ceil(total / effectiveLimit),
      },
      availableLanguages,
    };
  }

  // ===== Translations (Admin) =====
  listTranslations(
    tagId: string,
  ): Promise<Prisma.TagTranslationGetPayload<{ include: { seo: true } }>[]> {
    return this.prisma.tagTranslation.findMany({
      where: { tagId },
      orderBy: { language: 'asc' },
      include: { seo: true },
    });
  }

  /**
   * 🔴 `LEGACY-360`. Три ручки переводов идут под замком строки тега: импорт
   * решает «создать или обновить перевод» по снимку `TagTranslation`, и запись
   * мимо замка давала ему `P2002`/`P2025` при `updated: 1`. Запись `Seo`
   * и перевода — одна транзакция: прежняя компенсация в `catch` сама могла
   * упасть и оставляла `Seo` сиротой.
   */
  async createTranslation(tagId: string, dto: CreateTagTranslationDto) {
    return this.tagLock.runInLockedTag({ id: tagId }, async (tx) => {
      const exists = await tx.tag.findUnique({ where: { id: tagId } });
      if (!exists) throw new NotFoundException('Tag not found');

      let seoId: number | undefined;
      if (dto.seo) {
        const hasSeoData = Object.values(dto.seo).some((v) => v !== null && v !== undefined);
        if (hasSeoData) {
          const newSeo = await tx.seo.create({ data: dto.seo });
          seoId = newSeo.id;
        }
      }

      // После отказа оператора транзакция Postgres прервана: к `tx` больше
      // не обращаемся, откат снимает и `Seo`.
      try {
        return await tx.tagTranslation.create({
          data: {
            tagId,
            language: dto.language,
            name: dto.name,
            slug: dto.slug,
            description: dto.description ?? null,
            // See CategoryService.createTranslation — a new term is not indexable
            // until the recompute says otherwise.
            bookCount: 0,
            autoIndexable: false,
            ...(dto.relatedTagSlugs !== undefined ? { relatedTagSlugs: dto.relatedTagSlugs } : {}),
            ...(dto.relatedGenreSlugs !== undefined
              ? { relatedGenreSlugs: dto.relatedGenreSlugs }
              : {}),
            ...(dto.relatedCategorySlugs !== undefined
              ? { relatedCategorySlugs: dto.relatedCategorySlugs }
              : {}),
            ...(dto.relatedCollectionSlugs !== undefined
              ? { relatedCollectionSlugs: dto.relatedCollectionSlugs }
              : {}),
            ...(seoId !== undefined ? { seoId } : {}),
          },
          include: { seo: true },
        });
      } catch (e: unknown) {
        if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
          throw new BadRequestException('Translation with same (language, slug) already exists');
        }
        throw e;
      }
    });
  }

  async updateTranslation(tagId: string, language: Language, dto: UpdateTagTranslationDto) {
    return this.tagLock.runInLockedTag({ id: tagId }, async (tx) => {
      const tr = await tx.tagTranslation.findUnique({
        where: { tagId_language: { tagId, language } },
      });
      if (!tr) throw new NotFoundException('Translation not found');

      if (dto.slug) {
        const dup = await tx.tagTranslation.findFirst({
          where: { language, slug: dto.slug, NOT: { id: tr.id } },
        });
        if (dup)
          throw new BadRequestException('Translation with same (language, slug) already exists');
      }

      let finalSeoId: number | null | undefined = undefined;
      if (dto.seo) {
        const hasSeoData = Object.values(dto.seo).some((v) => v !== null && v !== undefined);
        if (hasSeoData) {
          if (tr.seoId) {
            await tx.seo.update({ where: { id: tr.seoId }, data: dto.seo });
            finalSeoId = tr.seoId;
          } else {
            const newSeo = await tx.seo.create({ data: dto.seo });
            finalSeoId = newSeo.id;
          }
        } else if (tr.seoId) {
          finalSeoId = null;
          await tx.seo.delete({ where: { id: tr.seoId } });
        }
      }

      // Та же транзакция, что и смена слага (LEGACY-062): порознь существовал бы
      // момент, когда слаг уже новый, а старый адрес ведёт в 404.
      const slugChanged = !!dto.slug && dto.slug !== tr.slug;

      if (slugChanged && dto.slug) {
        await this.slugRedirects.record(
          { entityType: 'tag', language, oldSlug: tr.slug, newSlug: dto.slug },
          tx,
        );
      }

      return tx.tagTranslation.update({
        where: { tagId_language: { tagId, language } },
        data: {
          name: dto.name,
          slug: dto.slug,
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.relatedTagSlugs !== undefined ? { relatedTagSlugs: dto.relatedTagSlugs } : {}),
          ...(dto.relatedGenreSlugs !== undefined
            ? { relatedGenreSlugs: dto.relatedGenreSlugs }
            : {}),
          ...(dto.relatedCategorySlugs !== undefined
            ? { relatedCategorySlugs: dto.relatedCategorySlugs }
            : {}),
          ...(dto.relatedCollectionSlugs !== undefined
            ? { relatedCollectionSlugs: dto.relatedCollectionSlugs }
            : {}),
          ...(finalSeoId !== undefined ? { seoId: finalSeoId } : {}),
        },
        include: { seo: true },
      });
    });
  }

  async deleteTranslation(tagId: string, language: Language) {
    await this.tagLock.runInLockedTag({ id: tagId }, async (tx) => {
      const tr = await tx.tagTranslation.findUnique({
        where: { tagId_language: { tagId, language } },
      });
      if (!tr) return;

      await tx.tagTranslation.delete({
        where: { tagId_language: { tagId, language } },
      });
      if (tr.seoId) {
        await tx.seo.delete({ where: { id: tr.seoId } });
      }
    });

    return { success: true };
  }

  async attach(versionId: string, tagId: string) {
    const [version, tag] = await Promise.all([
      this.prisma.bookVersion.findUnique({
        where: { id: versionId },
        select: { id: true, bookId: true },
      }),
      this.prisma.tag.findUnique({ where: { id: tagId } }),
    ]);
    if (!version) throw new NotFoundException('BookVersion not found');
    if (!tag) throw new NotFoundException('Tag not found');

    const siblings = await this.prisma.bookVersion.findMany({
      where: { bookId: version.bookId },
      select: { id: true },
    });

    await this.prisma.$transaction(async (tx) => {
      for (const sibling of siblings) {
        const exists = await tx.bookTag.findFirst({
          where: { bookVersionId: sibling.id, tagId },
          select: { id: true },
        });
        if (!exists) {
          await tx.bookTag.create({ data: { bookVersionId: sibling.id, tagId } });
        }
      }
    }, TAG_TX_OPTIONS);

    // The link now exists for every language of the book, so every language's
    // counter for this term is stale.
    await this.taxonomyIndexabilityService?.recomputeForTerms([], [tagId]);

    return this.prisma.bookTag.findFirst({
      where: { bookVersionId: versionId, tagId },
    });
  }

  async detach(versionId: string, tagId: string) {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: versionId },
      select: { bookId: true },
    });
    if (!version) throw new NotFoundException('BookVersion not found');

    const siblings = await this.prisma.bookVersion.findMany({
      where: { bookId: version.bookId },
      select: { id: true },
    });

    await this.prisma.$transaction(async (tx) => {
      for (const sibling of siblings) {
        const link = await tx.bookTag.findFirst({
          where: { bookVersionId: sibling.id, tagId },
        });
        if (link) {
          await tx.bookTag.delete({ where: { id: link.id } });
        }
      }
    }, TAG_TX_OPTIONS);

    // Must run after the delete and by term id: the version no longer points at
    // this tag, so a version-scoped recompute would miss exactly it.
    await this.taxonomyIndexabilityService?.recomputeForTerms([], [tagId]);

    return { success: true };
  }

  /**
   * Есть ли уже тег с таким слагом. `excludeId` — редактируемая запись: без него
   * форма сравнивала бы слаг сама с собой и сообщала «занят» (LEGACY-061).
   */
  async checkSlugExists(slug: string, excludeId?: string) {
    const where: Prisma.TagWhereInput = { slug };
    if (excludeId) {
      where.id = { not: excludeId };
    }
    return this.prisma.tag.findFirst({
      where,
      select: { id: true, name: true, slug: true },
    });
  }

  async generateUniqueSuggestedSlug(baseSlug: string): Promise<string> {
    let counter = 1;
    let candidate = baseSlug;

    let exists = await this.prisma.tag.findFirst({ where: { slug: candidate } });
    while (exists) {
      counter++;
      candidate = `${baseSlug}-${counter}`;
      exists = await this.prisma.tag.findFirst({ where: { slug: candidate } });
    }

    return candidate;
  }
}

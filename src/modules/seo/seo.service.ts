import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CategoryTreeService } from '../category/category-tree.service';
import { CategoryType, Language, Seo } from '@prisma/client';
import { UpdateSeoDto } from './dto/update-seo.dto';
import { ResolveSeoQueryDto, ResolveSeoTypeValue } from './dto/resolve-seo.dto';
import { getDefaultLanguage, resolveRequestedLanguage } from '../../shared/language/language.util';

// Modular SEO helpers
import { detectIndexability } from './utils/detectIndexability';
import { cleanDescription } from './utils/cleanDescription';
import { buildAbsoluteUrl } from './utils/buildAbsoluteUrl';
import { COLLECTIONS_NAMES, getCatalogName, getHomeName } from './utils/sectionNames';
import { getCanonicalUrl } from './canonical/getCanonicalUrl';
import { generateHreflangLinks } from './hreflang/generateHreflangLinks';
import { generateBookMeta } from './metadata/generateBookMeta';
import { generateGenreMeta } from './metadata/generateGenreMeta';
import { generateStaticPageMeta } from './metadata/generateStaticPageMeta';
import { generateCatalogMeta } from './metadata/generateCatalogMeta';
import { buildSocialCards } from './metadata/buildSocialCards';
import { generateBookSchema } from './schema/generateBookSchema';
import { generateBreadcrumbSchema } from './schema/generateBreadcrumbSchema';
import { generateWebSiteSchema } from './schema/generateWebSiteSchema';
import { buildTermBundle } from './schema/buildTermBundle';
import { TaxonomyPageType } from './seo.types';
import { markDegraded } from '../../common/interceptors/degraded-response';

const TAXONOMY_PAGES: Record<
  TaxonomyPageType,
  {
    /** Текст 404: он называет тот тип термина, страницу которого запросили (`LEGACY-273`). */
    notFound: string;
    /**
     * Раздел над термином в хлебных крошках. Есть только у коллекций:
     * у категорий и жанров страницы-раздела не существует, и крошка вела бы в 404.
     */
    section: { slug: string; names: Record<Language, string> } | null;
  }
> = {
  category: { notFound: 'Category translation not found', section: null },
  collection: {
    notFound: 'Collection not found',
    // Названия — из `utils/sectionNames.ts`, где лежат и «Главная», и «Каталог»:
    // локализованный ярлык раздела живёт в одном месте (`LEGACY-317`).
    section: { slug: 'collections', names: COLLECTIONS_NAMES },
  },
  genre: { notFound: 'Genre translation not found', section: null },
};

interface CategoryWithParent {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  type: string | null;
}

interface BookCategoryLink {
  category: CategoryWithParent;
}

/** Как запрошена страница: префикс пути, query, заголовок и слаг перевода. */
interface ResolvePublicOptions {
  pathLang?: Language;
  queryLang?: string;
  acceptLanguage?: string;
  slug?: string;
}

@Injectable()
export class SeoService {
  private cache = new Map<string, { value: Seo | null; expires: number }>();
  private readonly logger = new Logger(SeoService.name);

  private ttlMs: number;

  constructor(
    private prisma: PrismaService,
    private readonly categoryTree: CategoryTreeService,
  ) {
    const raw = process.env.SEO_CACHE_TTL_MS;
    const parsed = raw ? Number(raw) : NaN;
    this.ttlMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60 * 1000; // 5 minutes by default
  }

  /**
   * Pick the taxonomy translation to serve for `effLang`.
   *
   * Candidates are matched by slug across every language, so `/ru/...` carrying
   * an English slug matches only the English row. Serving that row was building
   * the canonical from the **requested** slug — `/ru/genre/historical-fiction` —
   * while the same response's hreflang block, built from the term id, pointed at
   * `/ru/genre/istoricheskaya-proza`. One page contradicting itself, and the
   * duplicate canonicalising to itself instead of to the real URL.
   *
   * So: resolve the term first, then load its translation into the requested
   * language explicitly. A term with no translation into that language is a 404 —
   * serving it under a foreign name is exactly the fallback this phase removes,
   * and it matches how tags already behave.
   */
  private async pickTaxonomyTranslation<
    T extends { language: Language; categoryId: string; slug: string },
  >(candidates: T[], effLang: Language, type: TaxonomyPageType): Promise<T> {
    const exact = candidates.find((c) => c.language === effLang);
    if (exact) return exact;

    const translated = await this.prisma.categoryTranslation.findFirst({
      where: {
        categoryId: candidates[0].categoryId,
        language: effLang,
        category: { type },
      },
      include: { category: true },
    });

    if (!translated) {
      throw new NotFoundException(`No ${type} translation for language ${effLang}`);
    }

    return translated as unknown as T;
  }

  /** Same contract as `pickTaxonomyTranslation`, for tags. */
  private async pickTagTranslation<T extends { language: Language; tagId: string; slug: string }>(
    candidates: T[],
    effLang: Language,
  ): Promise<T> {
    const exact = candidates.find((c) => c.language === effLang);
    if (exact) return exact;

    const translated = await this.prisma.tagTranslation.findFirst({
      where: { tagId: candidates[0].tagId, language: effLang },
      include: { tag: true },
    });

    if (!translated) {
      throw new NotFoundException(`No tag translation for language ${effLang}`);
    }

    return translated as unknown as T;
  }

  private getCache(key: string): Seo | null | undefined {
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    if (hit) this.cache.delete(key);
    return undefined;
  }

  private setCache(key: string, value: Seo | null) {
    this.cache.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  async getByVersion(bookVersionId: string) {
    const cacheKey = `seo:${bookVersionId}`;
    const cached = this.getCache(cacheKey);
    if (cached !== undefined) return cached;

    const version = await this.prisma.bookVersion.findUnique({ where: { id: bookVersionId } });
    if (!version) throw new NotFoundException('BookVersion not found');
    if (!version.seoId) return null;
    const data = await this.prisma.seo.findUnique({ where: { id: version.seoId } });
    this.setCache(cacheKey, data);
    return data;
  }

  async upsertForVersion(bookVersionId: string, dto: UpdateSeoDto) {
    const version = await this.prisma.bookVersion.findUnique({ where: { id: bookVersionId } });
    if (!version) throw new NotFoundException('BookVersion not found');

    if (!version.seoId) {
      const created = await this.prisma.seo.create({ data: { ...this.dtoToData(dto) } });
      await this.prisma.bookVersion.update({
        where: { id: bookVersionId },
        data: { seoId: created.id },
      });
      this.setCache(`seo:${bookVersionId}`, created);
      return created;
    }

    const updated = await this.prisma.seo.update({
      where: { id: version.seoId },
      data: this.dtoToData(dto),
    });
    this.setCache(`seo:${bookVersionId}`, updated);
    return updated;
  }

  private dtoToData(dto: UpdateSeoDto) {
    const {
      metaTitle,
      metaDescription,
      canonicalUrl,
      robots,
      ogTitle,
      ogDescription,
      ogType,
      ogUrl,
      ogImageUrl,
      ogImageAlt,
      twitterCard,
      twitterSite,
      twitterCreator,
      eventName,
      eventDescription,
      eventStartDate,
      eventEndDate,
      eventUrl,
      eventImageUrl,
      eventLocationName,
      eventLocationStreet,
      eventLocationCity,
      eventLocationRegion,
      eventLocationPostal,
      eventLocationCountry,
    } = dto;
    return {
      metaTitle,
      metaDescription,
      canonicalUrl,
      robots,
      ogTitle,
      ogDescription,
      ogType,
      ogUrl,
      ogImageUrl,
      ogImageAlt,
      twitterCard,
      twitterSite,
      twitterCreator,
      eventName,
      eventDescription,
      eventStartDate: eventStartDate ? new Date(eventStartDate) : undefined,
      eventEndDate: eventEndDate ? new Date(eventEndDate) : undefined,
      eventUrl,
      eventImageUrl,
      eventLocationName,
      eventLocationStreet,
      eventLocationCity,
      eventLocationRegion,
      eventLocationPostal,
      eventLocationCountry,
    };
  }

  // Backwards compatible fallback resolver
  async resolve(query: ResolveSeoQueryDto): Promise<unknown> {
    return this.resolvePublic(query.type, query.id, { slug: query.slug });
  }

  /**
   * 🔴 `LEGACY-277`. Семь блоков `resolvePublic` обёрнуты в `try/catch` потому,
   * что крошки, жанры, рейтинг и отзывы для страницы необязательны: их отказ
   * не должен ронять публичный ответ. Но пустой `catch` вокруг обращения
   * к базе делает отказ базы неотличимым от «данных нет»: маршрут отвечает
   * 200, `BreadcrumbList` уезжает поисковику обеднённым как факт, и заметить
   * это больше нечем — ни в логах, ни в Sentry.
   *
   * ⚠️ Ответ намеренно остаётся прежним: 200 с неполным JSON-LD. Меняется
   * только то, что отказ перестаёт быть невидимым.
   *
   * Прямого `captureException` здесь нет и он не нужен: глобальный фильтр
   * (`shared/sentry/sentry.filter.ts`) шлёт 5xx, а здесь исключение поймано.
   * Маршрут публичный и кэшируемый — поток дублей с него лёг бы поверх того
   * же отказа базы, уже видимого с других ручек.
   */
  private warnDegraded(part: string, pageType: string, id: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(
      `SEO ${pageType} "${id}": failed to load ${part}, response degraded (200 with partial data). ${reason}`,
    );
  }

  /**
   * Публичный резолвер страницы термина таксономии — один на три типа.
   *
   * 🔴 `LEGACY-309`. Отличий между типами ровно два, и оба здесь — данными,
   * а не веткой: текст 404 и статическая крошка раздела у коллекций. Всё
   * остальное — подбор перевода, чтение `Seo`, `detectIndexability`, сбор
   * hreflang, крошки, `generateCollectionPageSchema` и весь возвращаемый
   * объект — общее, и тип берётся из аргумента, а не из литерала.
   */
  private async resolveTaxonomyPublic(
    termType: TaxonomyPageType,
    id: string,
    effLang: Language,
    slugVal: string,
  ): Promise<Record<string, unknown>> {
    const page = TAXONOMY_PAGES[termType];

    const transCandidates = await this.prisma.categoryTranslation.findMany({
      where: {
        OR: [{ slug: slugVal }, { categoryId: id }],
        category: { type: termType },
      },
      include: { category: true },
    });

    if (transCandidates.length === 0) {
      throw new NotFoundException(page.notFound);
    }

    const chosen = await this.pickTaxonomyTranslation(transCandidates, effLang, termType);

    const baseMeta = generateGenreMeta({
      name: chosen.name,
      description: chosen.description,
      language: effLang,
    });

    const seo = chosen.seoId
      ? await this.prisma.seo.findUnique({ where: { id: chosen.seoId } })
      : null;
    const metaTitle = seo?.metaTitle || baseMeta.title;
    const metaDescription = seo?.metaDescription || baseMeta.description || undefined;
    const canonicalUrl = getCanonicalUrl(termType, chosen.slug, effLang);
    const robotsStatus = detectIndexability(
      'published',
      canonicalUrl,
      seo?.robots,
      chosen.category.indexable !== false && chosen.autoIndexable !== false,
    );

    // Hreflangs — fetch all translations of this term for complete hreflang set
    const allTranslations = await this.prisma.categoryTranslation.findMany({
      where: { categoryId: chosen.categoryId, category: { type: termType } },
    });
    const slugsMap: Record<string, string> = {};
    for (const tr of allTranslations) {
      slugsMap[tr.language.toLowerCase()] = tr.slug;
    }

    // Крошки между главной и самим термином: раздел плюс предки.
    const trail: Array<{ name: string; url: string }> = [];
    // Раздел над термином есть только у коллекций: у категорий и жанров
    // страницы-раздела не существует, и подставлять её было бы ссылкой в 404.
    if (page.section) {
      trail.push({
        name: page.section.names[effLang] ?? page.section.names.en,
        url: getCanonicalUrl('static', page.section.slug, effLang),
      });
    }

    // Add parent categories
    let degraded = false;
    try {
      const catPath = chosen.category
        ? await this.buildCategoryTrail(chosen.category, effLang, false)
        : [];
      catPath.forEach((parent) => {
        trail.push({
          name: parent.name,
          url: getCanonicalUrl(termType, parent.slug, effLang),
        });
      });
    } catch (error) {
      degraded = true;
      this.warnDegraded('parent breadcrumbs', termType, chosen.categoryId, error);
    }

    const bundle = buildTermBundle({
      pageType: termType,
      effLang,
      slug: chosen.slug,
      name: chosen.name,
      metaTitle,
      metaDescription,
      canonicalUrl,
      robots: robotsStatus,
      seo,
      slugsMap,
      trail,
    });

    return degraded ? markDegraded(bundle) : bundle;
  }

  /**
   * Цепочка категорий для хлебных крошек — от корня к узлу, уже с переводами.
   *
   * 🔴 `LEGACY-265`. Здесь было четыре одинаковых `while` по `parentId` без
   * потолка и без множества посещённых — на публичных маршрутах `/seo/resolve`.
   * Петля `A → B → A` в базе (её оставили прежние версии импорта, см.
   * `LEGACY-263`) означала не медленный ответ, а запрос, который не вернётся
   * никогда: окружающий `try { } catch { }` бесконечный цикл не ловит, потому
   * что исключения нет. Подъём один и тот же для книги, категории, коллекции и
   * жанра, поэтому и место ему одно.
   *
   * Переводы берутся **одним** `findMany` по собранным идентификаторам, а не
   * запросом на уровень: было по два обращения на уровень, стало одно на
   * уровень внутри `collectAncestors` плюс один запрос на всю цепочку.
   *
   * `includeSelf` — про ветку книги: её крошки содержат и саму категорию книги,
   * тогда как страницы категории, коллекции и жанра добавляют себя отдельно,
   * уже после цепочки предков.
   *
   * Фолбэк на базовое имя намеренно через `||`, а не `??`: пустая строка
   * перевода и раньше уходила на `category.name`.
   */
  private async buildCategoryTrail(
    node: { id: string; name: string; slug: string; parentId: string | null; type: string | null },
    effLang: Language,
    includeSelf: boolean,
  ): Promise<Array<{ name: string; slug: string; type: string | null }>> {
    const ancestors = await this.categoryTree.collectAncestors(node.id, node.parentId);
    // От узла к корню: сперва сам узел (если он нужен), затем предки по порядку.
    const chain: Array<{ id: string; name: string; slug: string; type: string | null }> =
      includeSelf ? [node, ...ancestors] : [...ancestors];
    if (chain.length === 0) return [];

    const translations = await this.prisma.categoryTranslation.findMany({
      where: { categoryId: { in: chain.map((c) => c.id) }, language: effLang },
      select: { categoryId: true, name: true, slug: true },
    });
    const byCategory = new Map(translations.map((tr) => [tr.categoryId, tr]));

    return chain
      .map((c) => {
        const trans = byCategory.get(c.id);
        return {
          name: trans?.name || c.name,
          slug: trans?.slug || c.slug,
          type: c.type,
        };
      })
      .reverse();
  }

  /**
   * Public resolver with language awareness.
   */
  /**
   * Язык страницы: префикс пути важнее query, query важнее `Accept-Language`.
   *
   * ⚠️ Префикс берётся только если запрошенный язык реально есть у сущности:
   * иначе `/es/...` у книги без испанской версии отдал бы пустую страницу
   * вместо фолбэка.
   */
  private pickEffectiveLanguage(
    opts: ResolvePublicOptions | undefined,
    available?: Language[],
  ): Language {
    const availableArr = available && available.length > 0 ? available : undefined;
    if (availableArr && opts?.pathLang && availableArr.includes(opts.pathLang)) {
      return opts.pathLang;
    }
    const resolved = resolveRequestedLanguage({
      queryLang: opts?.queryLang,
      acceptLanguage: opts?.acceptLanguage,
      available: availableArr,
    });
    return resolved ?? getDefaultLanguage();
  }

  /**
   * Публичный резолвер SEO-ответа. Сам ничего не собирает: выбирает по типу
   * страницы её резолвер и отдаёт результат.
   */
  async resolvePublic(
    // `LEGACY-319`. Был union из восьми литералов, объединённый с `ResolveSeoType`,
    // который содержит ровно те же восемь: объединение ничего не добавляло, зато
    // держало девятую копию списка. Источник один - enum, он же валидирует DTO
    // и он же уходит в `@ApiQuery` контроллера.
    type: ResolveSeoTypeValue,
    id: string,
    opts?: ResolvePublicOptions,
  ): Promise<Record<string, unknown>> {
    // ⚠️ Проверка остаётся, хотя таблица полна по типу: `type` приходит
    // из контроллера после сужения строки запроса, и приведение мимо него
    // возможно. Полнота таблицы стережёт забытый тип, эта строка — подделанный.
    //
    // 🔴 Поиск идёт через `hasOwnProperty`, а не по истинности значения:
    // у объектного литерала есть унаследованные ключи, и `table['constructor']`,
    // `table['toString']`, `table['valueOf']` вернули бы функцию прототипа —
    // истинную, то есть прошли бы мимо этого `throw` и были бы вызваны как
    // резолвер. Сегодня такие значения отсекают оба входа (`isResolveSeoType`
    // в контроллере и `@IsEnum` в DTO), но проверка, которая держится на чужой
    // проверке, не проверка.
    const resolvers = this.publicResolvers();
    if (!Object.prototype.hasOwnProperty.call(resolvers, type)) {
      throw new NotFoundException('Unsupported type');
    }
    return resolvers[type](id, opts);
  }

  /**
   * Диспетчер публичного резолва: тип страницы -> метод, который её собирает.
   *
   * 🔴 `LEGACY-317`. До 30.08.2026 это была лесенка из шести `if (t === ...)`
   * внутри одного метода на 733 строки. Общих полей у веток нет — каждая читает
   * свою модель, строит свой ответ и выходит `return`, — то есть это были шесть
   * резолверов, сложенных в один метод.
   *
   * ⚠️ Таблица объявлена как `Record<ResolveSeoTypeValue, ...>` ради
   * компилятора: новый тип страницы в `ResolveSeoType` уронит сборку здесь,
   * а не провалится мимо всех `if` в хвостовой `NotFoundException`. Ровно так
   * прежде и терялись типы — тихо, до первого обращения снаружи.
   */
  private publicResolvers(): Record<
    ResolveSeoTypeValue,
    (id: string, opts?: ResolvePublicOptions) => Promise<Record<string, unknown>>
  > {
    // 🔴 `LEGACY-309`. Три типа таксономии идут одним резолвером, а не тремя
    // копиями: до 29.08.2026 это были три ветки, совпадавшие дословно в 96
    // строках из 130, и имя типа в каждой писалось руками отдельным литералом.
    // Ни компилятор, ни линт подмены не видели — так и вышла `LEGACY-273`.
    // Новый тип таксономии заводится записью в `TAXONOMY_PAGES`.
    const taxonomy = (termType: TaxonomyPageType) => (id: string, opts?: ResolvePublicOptions) =>
      this.resolveTaxonomyPublic(
        termType,
        id,
        opts?.pathLang ?? this.pickEffectiveLanguage(opts),
        opts?.slug || id,
      );

    return {
      version: (id) => this.resolveVersionPublic(id),
      book: (id, opts) => this.resolveBookPublic(id, opts),
      page: (id, opts) => this.resolvePagePublic(id, opts),
      category: taxonomy(CategoryType.category),
      collection: taxonomy(CategoryType.collection),
      genre: taxonomy(CategoryType.genre),
      tag: (id, opts) => this.resolveTagPublic(id, opts),
      catalog: (_id, opts) => Promise.resolve(this.resolveCatalogPublic(opts)),
    };
  }

  /**
   * Страница конкретной версии книги. Адрес у неё один на все языки
   * (`/versions/:id`), поэтому ни `hreflangs`, ни `breadcrumbPath` она не отдаёт.
   *
   * ⚠️ Запрошенного языка не принимает намеренно: версия — это уже выбранный
   * язык, и он берётся из самой записи. Пока ветка стояла внутри общего метода,
   * `pickEffectiveLanguage` был у неё под рукой, и то, что она им не пользуется,
   * приходилось вычитывать из тела.
   */
  private async resolveVersionPublic(id: string): Promise<Record<string, unknown>> {
    const v = await this.prisma.bookVersion.findUnique({
      where: { id },
    });
    if (!v) throw new NotFoundException('BookVersion not found');

    const baseMeta = generateBookMeta({
      title: v.title,
      author: v.author,
      description: v.description,
      language: v.language,
    });

    const seo = v.seoId ? await this.prisma.seo.findUnique({ where: { id: v.seoId } }) : null;
    const metaTitle = seo?.metaTitle || baseMeta.title;
    const metaDescription = seo?.metaDescription || baseMeta.description || undefined;
    const canonicalUrl = getCanonicalUrl('version', v.id);
    const robotsStatus = detectIndexability(v.status, canonicalUrl, seo?.robots);

    const { openGraph, twitter } = buildSocialCards({
      seo,
      metaTitle,
      metaDescription,
      canonicalUrl,
      ogType: 'book',
      coverImageUrl: v.coverImageUrl,
    });

    // Breadcrumbs
    const breadcrumbItems = [
      { name: getHomeName(v.language), url: getCanonicalUrl('static', '', v.language) },
      { name: v.title, url: canonicalUrl },
    ];
    const breadcrumbSchema = generateBreadcrumbSchema(breadcrumbItems, canonicalUrl);
    const bookSchema = generateBookSchema({
      slug: v.slug || v.id,
      title: v.title,
      authorName: v.author,
      language: v.language,
      genres: [],
      coverImageUrl: v.coverImageUrl,
      description: metaDescription,
      textAvailable: v.type === 'text',
      audioAvailable: v.type === 'audio',
    });

    return {
      meta: {
        title: metaTitle,
        description: metaDescription,
        robots: robotsStatus,
        canonicalUrl,
      },
      openGraph,
      twitter,
      schema: {
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'WebPage',
            '@id': `${canonicalUrl}#webpage`,
            url: canonicalUrl,
            name: metaTitle,
            description: metaDescription,
            inLanguage: v.language.toLowerCase(),
            breadcrumb: { '@id': `${canonicalUrl}#breadcrumb` },
          },
          breadcrumbSchema,
          bookSchema,
        ],
      },
    };
  }

  /**
   * Страница книги: единственная ветка, которая деградирует по частям.
   * Жанры, рейтинг и отзывы необязательны, их отказ помечает ответ
   * (`LEGACY-277`, `LEGACY-305`), но не роняет его.
   */
  private async resolveBookPublic(
    id: string,
    opts?: ResolvePublicOptions,
  ): Promise<Record<string, unknown>> {
    // 🔴 `LEGACY-305`. Ответ, собранный после отказа базы на необязательном
    // блоке, помечается служебным символом: `PublicCacheInterceptor` снимет
    // метку и переведёт такой ответ на короткий кэш. Без этого обеднённая
    // разметка уезжала на общий кэш и раздавалась час, а `Logger.warn`
    // показывал один-единственный случай деградации.
    let degraded = false;
    // Find version by slug or book by slug
    const targetVersion = await this.prisma.bookVersion.findFirst({
      where: { slug: id, status: 'published' },
    });

    let bookId: string | null = null;
    if (targetVersion) {
      bookId = targetVersion.bookId;
    } else {
      const legacyBook = await this.prisma.book.findUnique({
        where: { slug: id },
      });
      if (legacyBook) {
        bookId = legacyBook.id;
      }
    }

    if (!bookId) {
      throw new NotFoundException(`Book not found for slug or id "${id}"`);
    }

    const versions = await this.prisma.bookVersion.findMany({
      where: { bookId, status: 'published' },
    });

    const available = versions.map((v) => v.language);
    const effLang = this.pickEffectiveLanguage(opts, available);
    const chosen = versions.find((v) => v.language === effLang) ?? versions[0];

    if (!chosen) {
      // Fallback if book has no published versions
      const canonicalUrl = getCanonicalUrl('book', id, effLang);
      // Записи `Seo` тут неоткуда взяться: её держит версия, а версий нет.
      // Но собирается блок тем же генератором, что и остальные пять веток
      // (`LEGACY-317`): с `seo: null` и без обложки он даёт ровно прежний
      // ответ — маленькую карточку и Open Graph без картинки.
      const { openGraph, twitter } = buildSocialCards({
        seo: null,
        metaTitle: `Book ${id}`,
        canonicalUrl,
        ogType: 'book',
      });
      return {
        meta: {
          title: `Book ${id}`,
          description: undefined,
          robots: 'noindex, follow',
          canonicalUrl,
        },
        openGraph,
        twitter,
        schema: {
          '@context': 'https://schema.org',
          '@graph': [generateWebSiteSchema(effLang)],
        },
      };
    }

    const cleanedDesc = await cleanDescription(
      this.prisma,
      chosen.id,
      chosen.title,
      chosen.author,
      effLang,
      chosen.description,
    );

    const baseMeta = generateBookMeta({
      title: chosen.title,
      author: chosen.author,
      description: cleanedDesc,
      language: effLang,
    });

    const seo = chosen.seoId
      ? await this.prisma.seo.findUnique({ where: { id: chosen.seoId } })
      : null;
    const metaTitle = seo?.metaTitle || baseMeta.title;
    const metaDescription = seo?.metaDescription || baseMeta.description || undefined;
    const canonicalUrl = getCanonicalUrl('book', chosen.slug || id, effLang);
    const robotsStatus = detectIndexability(chosen.status, canonicalUrl, seo?.robots);

    const { openGraph, twitter } = buildSocialCards({
      seo,
      metaTitle,
      metaDescription,
      canonicalUrl,
      ogType: 'book',
      coverImageUrl: chosen.coverImageUrl,
    });

    // Hreflang alternate links
    const slugsMap: Record<string, string> = {};
    for (const v of versions) {
      if (v.slug) {
        slugsMap[v.language.toLowerCase()] = v.slug;
      }
    }
    const hreflangLinks = generateHreflangLinks('book', slugsMap);

    // Breadcrumbs
    const breadcrumbItems: Array<{ name: string; url: string; type?: string }> = [
      { name: getHomeName(effLang), url: getCanonicalUrl('static', '', effLang) },
    ];

    // Add Category breadcrumbs
    try {
      let cat: CategoryWithParent | null = null;
      if (chosen.primaryCategoryId) {
        cat = await this.prisma.category.findUnique({
          where: { id: chosen.primaryCategoryId },
          select: { id: true, name: true, slug: true, parentId: true, type: true },
        });
      }
      if (!cat) {
        const rawLinks = await this.prisma.bookCategory.findMany({
          where: { bookVersionId: chosen.id },
          select: {
            category: {
              select: { id: true, name: true, slug: true, parentId: true, type: true },
            },
          },
        });
        const links = rawLinks as unknown as BookCategoryLink[];
        cat = links[0]?.category ?? null;
      }
      if (cat) {
        const catPath = await this.buildCategoryTrail(cat, effLang, true);
        catPath.forEach((p) => {
          const taxonomyType = p.type === 'genre' || p.type === 'collection' ? p.type : 'category';
          breadcrumbItems.push({
            name: p.name,
            url: getCanonicalUrl(taxonomyType, p.slug, effLang),
            type: taxonomyType,
          });
        });
      }
    } catch (error) {
      degraded = true;
      this.warnDegraded('breadcrumb categories', 'book', chosen.id, error);
    }

    breadcrumbItems.push({ name: chosen.title, url: canonicalUrl });
    const breadcrumbSchema = generateBreadcrumbSchema(breadcrumbItems, canonicalUrl);

    // Add genres
    const genresList: string[] = [];
    try {
      const bookCategories = await this.prisma.bookCategory.findMany({
        where: { bookVersionId: chosen.id },
        include: { category: { include: { translations: true } } },
      });
      for (const bc of bookCategories) {
        const trans =
          bc.category.translations.find((t) => t.language === effLang) ||
          bc.category.translations[0];
        if (trans) genresList.push(trans.name);
      }
    } catch (error) {
      degraded = true;
      this.warnDegraded('genre list', 'book', chosen.id, error);
    }

    // Ratings
    let ratingAverage: number | null = null;
    let ratingCount = 0;
    try {
      // 🔴 `LEGACY-307`. Среднее и количество считает база одним `aggregate`,
      // а не приложение по всем строкам рейтинга. Прежний `findMany` без
      // `take` тянул в память столько строк, сколько у книги оценок, ради
      // двух чисел; на тестовых объёмах это выглядело исправным, а разница
      // появляется там, где оценок тысячи. Индекс `@@index([bookId])`
      // запрос покрывает, форма ответа не меняется.
      const stats = await this.prisma.bookRating.aggregate({
        where: { bookId: chosen.bookId },
        _avg: { score: true },
        _count: { _all: true },
      });
      ratingCount = stats._count._all;
      if (ratingCount > 0 && stats._avg.score !== null) {
        // Округление остаётся на стороне приложения: `AggregateRating`
        // отдаёт строку с двумя знаками, и менять её форму запись не просит.
        ratingAverage = parseFloat(stats._avg.score.toFixed(2));
      }
    } catch (error) {
      degraded = true;
      // `chosen.id`, а не `chosen.bookId`: под общим префиксом `SEO book "…"`
      // все четыре блока ветки обязаны называть одну и ту же страницу, иначе
      // разбор отказа грепом по её идентификатору найдёт три деградации из четырёх.
      this.warnDegraded('ratings', 'book', chosen.id, error);
    }

    // Retrieve published comments for schema.org review
    let bookComments: Array<{
      text: string;
      createdAt: Date;
      user: { name: string | null } | null;
    }> = [];
    try {
      bookComments = await this.prisma.comment.findMany({
        where: { bookVersionId: chosen.id, isDeleted: false, isHidden: false, parentId: null },
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { name: true } } },
      });
    } catch (error) {
      degraded = true;
      this.warnDegraded('comments', 'book', chosen.id, error);
    }

    const bookSchema = generateBookSchema({
      slug: chosen.slug || id,
      title: chosen.title,
      authorName: chosen.author,
      authorSlug: encodeURIComponent(
        (chosen.author || '').trim().toLowerCase().replace(/\s+/g, '-'),
      ),
      language: effLang,
      genres: genresList,
      coverImageUrl: chosen.coverImageUrl,
      description: metaDescription,
      textAvailable: chosen.type === 'text',
      audioAvailable: chosen.type === 'audio',
      ratingAverage,
      ratingCount,
      reviews: bookComments.map((c) => ({
        authorName: c.user?.name || 'Anonymous',
        reviewBody: c.text,
        datePublished: c.createdAt.toISOString(),
      })),
    });

    const bundle = {
      meta: {
        title: metaTitle,
        description: metaDescription,
        robots: robotsStatus,
        canonicalUrl,
      },
      openGraph,
      twitter,
      schema: {
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'WebPage',
            '@id': `${canonicalUrl}#webpage`,
            url: canonicalUrl,
            name: metaTitle,
            description: metaDescription,
            inLanguage: effLang.toLowerCase(),
            isPartOf: { '@id': `${buildAbsoluteUrl('/')}#website` },
            breadcrumb: { '@id': `${canonicalUrl}#breadcrumb` },
          },
          generateWebSiteSchema(effLang),
          breadcrumbSchema,
          bookSchema,
        ],
      },
      hreflangs: hreflangLinks,
      breadcrumbPath: breadcrumbItems.slice(1, -1).map((item: Record<string, string>) => ({
        name: item.name,
        slug: item.url.split('/').pop() || '',
        ...(item.type ? { type: item.type } : {}),
      })),
    };

    return degraded ? markDegraded(bundle) : bundle;
  }

  /**
   * Статическая страница CMS. `breadcrumbPath` не отдаёт: предков у неё нет.
   */
  private async resolvePagePublic(
    id: string,
    opts?: ResolvePublicOptions,
  ): Promise<Record<string, unknown>> {
    const candidates = await this.prisma.page.findMany({
      where: { slug: id, status: 'published' },
    });
    if (candidates.length === 0) throw new NotFoundException('Page not found');

    const available = candidates.map((c) => c.language);
    const effLang = this.pickEffectiveLanguage(opts, available);
    const chosen = candidates.find((c) => c.language === effLang) ?? candidates[0];

    const page = await this.prisma.page.findUnique({
      where: { id: chosen.id },
    });
    if (!page) throw new NotFoundException('Page not found');

    const baseMeta = generateStaticPageMeta({
      title: page.title,
      content: page.content,
      language: effLang,
    });

    const seo = page.seoId ? await this.prisma.seo.findUnique({ where: { id: page.seoId } }) : null;
    const metaTitle = seo?.metaTitle || baseMeta.title;
    const metaDescription = seo?.metaDescription || baseMeta.description || undefined;
    const canonicalUrl = getCanonicalUrl('page', page.slug, effLang);
    const robotsStatus = detectIndexability(page.status, canonicalUrl, seo?.robots);

    const { openGraph, twitter } = buildSocialCards({
      seo,
      metaTitle,
      metaDescription,
      canonicalUrl,
      ogType: 'website',
    });

    // Hreflangs
    const slugsMap: Record<string, string> = {};
    const pagesInGroup = page.translationGroupId
      ? await this.prisma.page.findMany({
          where: { translationGroupId: page.translationGroupId, status: 'published' },
        })
      : candidates;

    for (const p of pagesInGroup) {
      slugsMap[p.language.toLowerCase()] = p.slug;
    }
    const hreflangLinks = generateHreflangLinks('page', slugsMap);

    // Breadcrumbs
    const breadcrumbItems = [
      { name: getHomeName(effLang), url: getCanonicalUrl('static', '', effLang) },
      { name: page.title, url: canonicalUrl },
    ];
    const breadcrumbSchema = generateBreadcrumbSchema(breadcrumbItems, canonicalUrl);

    // Event Schema (optional support for old tests)
    const eventSchema = seo?.eventName
      ? {
          '@type': 'Event',
          name: seo.eventName,
          description: seo.eventDescription || undefined,
          startDate: seo.eventStartDate?.toISOString(),
          endDate: seo.eventEndDate?.toISOString(),
          url: seo.eventUrl || undefined,
          image: seo.eventImageUrl || undefined,
          location: seo.eventLocationName
            ? {
                '@type': 'Place',
                name: seo.eventLocationName,
                address: {
                  '@type': 'PostalAddress',
                  streetAddress: seo.eventLocationStreet || undefined,
                  addressLocality: seo.eventLocationCity || undefined,
                  addressRegion: seo.eventLocationRegion || undefined,
                  postalCode: seo.eventLocationPostal || undefined,
                  addressCountry: seo.eventLocationCountry || undefined,
                },
              }
            : undefined,
        }
      : undefined;

    const graph: Record<string, unknown>[] = [
      {
        '@type': 'WebPage',
        '@id': `${canonicalUrl}#webpage`,
        url: canonicalUrl,
        name: metaTitle,
        description: metaDescription,
        inLanguage: effLang.toLowerCase(),
        isPartOf: { '@id': `${buildAbsoluteUrl('/')}#website` },
        breadcrumb: { '@id': `${canonicalUrl}#breadcrumb` },
      },
      generateWebSiteSchema(effLang),
      breadcrumbSchema,
    ];
    if (eventSchema) {
      graph.push(eventSchema);
    }

    const result: {
      meta: Record<string, unknown>;
      openGraph: Record<string, unknown>;
      twitter: Record<string, unknown>;
      schema: { '@context': string; '@graph': Record<string, unknown>[]; event?: unknown };
      hreflangs: unknown[];
    } = {
      meta: {
        title: metaTitle,
        description: metaDescription,
        robots: robotsStatus,
        canonicalUrl,
      },
      openGraph,
      twitter,
      schema: {
        '@context': 'https://schema.org',
        '@graph': graph,
      },
      hreflangs: hreflangLinks,
    };

    // Compatibility for legacy tests checking schema.event directly
    if (seo?.eventName) {
      result.schema.event = {
        name: seo.eventName,
        description: seo.eventDescription || undefined,
        startDate: seo.eventStartDate?.toISOString(),
        endDate: seo.eventEndDate?.toISOString(),
        url: seo.eventUrl || undefined,
        image: seo.eventImageUrl || undefined,
        location: seo.eventLocationName
          ? {
              name: seo.eventLocationName,
              street: seo.eventLocationStreet || undefined,
              city: seo.eventLocationCity || undefined,
              region: seo.eventLocationRegion || undefined,
              postal: seo.eventLocationPostal || undefined,
              country: seo.eventLocationCountry || undefined,
            }
          : undefined,
      };
    }

    return result;
  }

  /**
   * Страница тега. Готовит только своё — модель, флаги индексируемости
   * и текст 404, — а ответ собирает общий `buildTermBundle`.
   */
  private async resolveTagPublic(
    id: string,
    opts?: ResolvePublicOptions,
  ): Promise<Record<string, unknown>> {
    // 🔴 `LEGACY-316`. Ветка готовит только своё: модель, три флага
    // индексируемости и свой текст 404. Сам ответ собирает `buildTermBundle` —
    // тот же, что у трёх типов таксономии. До 29.08.2026 здесь лежала четвёртая
    // копия сборки, уже разошедшаяся с остальными: `breadcrumbPath` она
    // не отдавала, а имя типа писала тремя отдельными литералами `'tag'`.
    // Одно имя типа на всю ветку: второй литерал — это и есть тот приём,
    // которым `LEGACY-273` подменила тип в соседней ветке незамеченно.
    const pageType = 'tag' as const;
    const effLang = opts?.pathLang ?? this.pickEffectiveLanguage(opts);
    const slugVal = opts?.slug || id;

    const transCandidates = await this.prisma.tagTranslation.findMany({
      where: {
        OR: [{ slug: slugVal }, { tagId: id }],
      },
      include: { tag: true },
    });

    if (transCandidates.length === 0) {
      throw new NotFoundException('Tag translation not found');
    }

    const chosen = await this.pickTagTranslation(transCandidates, effLang);

    const baseMeta = generateGenreMeta({
      name: chosen.name,
      description: chosen.description,
      language: effLang,
    });

    const seo = chosen.seoId
      ? await this.prisma.seo.findUnique({ where: { id: chosen.seoId } })
      : null;
    const metaTitle = seo?.metaTitle || baseMeta.title;
    const metaDescription = seo?.metaDescription || baseMeta.description || undefined;
    const canonicalUrl = getCanonicalUrl(pageType, chosen.slug, effLang);
    // ⚠️ Флагов три, а не два, как у таксономии: у `TagTranslation` есть
    // собственный `indexable`, которого у `CategoryTranslation` нет вовсе.
    // Это различие держит схема, а не расхождение копий.
    const effectiveIndexable =
      chosen.tag?.indexable !== false &&
      chosen.indexable !== false &&
      chosen.autoIndexable !== false;
    const robotsStatus = detectIndexability(
      'published',
      canonicalUrl,
      seo?.robots,
      effectiveIndexable,
    );

    // Hreflangs — fetch all translations of this tag for complete hreflang set
    const allTagTranslations = await this.prisma.tagTranslation.findMany({
      where: { tagId: chosen.tagId },
    });
    const slugsMap: Record<string, string> = {};
    for (const tr of allTagTranslations) {
      slugsMap[tr.language.toLowerCase()] = tr.slug;
    }

    return buildTermBundle({
      pageType,
      effLang,
      slug: chosen.slug,
      name: chosen.name,
      metaTitle,
      metaDescription,
      canonicalUrl,
      robots: robotsStatus,
      seo,
      slugsMap,
      // Предков у тега не бывает: у модели `Tag` нет `parentId`. Пустой список
      // отдаётся явно, чтобы форма ответа не отличалась от остальных трёх типов.
      trail: [],
    });
  }

  /**
   * Корень каталога. Единственная ветка, которая не читает базу вовсе
   * и не имеет записи `Seo`, — поэтому она и не асинхронная: обещание
   * в возвращаемом типе скрывало бы, что здесь нечего ждать.
   *
   * Идентификатора у страницы нет: каталог один, его слаг — литерал.
   */
  private resolveCatalogPublic(opts?: ResolvePublicOptions): Record<string, unknown> {
    const effLang = opts?.pathLang ?? this.pickEffectiveLanguage(opts);
    const baseMeta = generateCatalogMeta({ language: effLang });

    const canonicalUrl = getCanonicalUrl('static', 'catalog', effLang);

    // Hreflangs
    const slugsMap = {
      en: 'catalog',
      es: 'catalog',
      pt: 'catalog',
      fr: 'catalog',
      ru: 'catalog',
    };
    const hreflangLinks = generateHreflangLinks('static', slugsMap);

    // Breadcrumbs
    const breadcrumbItems = [
      { name: getHomeName(effLang), url: getCanonicalUrl('static', '', effLang) },
      { name: getCatalogName(effLang), url: canonicalUrl },
    ];
    const breadcrumbSchema = generateBreadcrumbSchema(breadcrumbItems, canonicalUrl);

    // Каталог — единственная ветка без записи `Seo`: ручной SEO у корня раздела
    // не заводится. Блок всё равно собирается общим генератором (`LEGACY-317`):
    // с `seo: null` он даёт прежний ответ, а следующая правка правил Open Graph
    // не пройдёт мимо этой страницы.
    const { openGraph, twitter } = buildSocialCards({
      seo: null,
      metaTitle: baseMeta.title,
      metaDescription: baseMeta.description,
      canonicalUrl,
      ogType: 'website',
    });

    return {
      meta: {
        title: baseMeta.title,
        description: baseMeta.description,
        robots: 'index, follow',
        canonicalUrl,
      },
      openGraph,
      twitter,
      schema: {
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'CollectionPage',
            '@id': `${canonicalUrl}#webpage`,
            url: canonicalUrl,
            name: baseMeta.title,
            description: baseMeta.description,
            inLanguage: effLang.toLowerCase(),
            isPartOf: { '@id': `${buildAbsoluteUrl('/')}#website` },
            breadcrumb: { '@id': `${canonicalUrl}#breadcrumb` },
          },
          generateWebSiteSchema(effLang),
          breadcrumbSchema,
        ],
      },
      hreflangs: hreflangLinks,
    };
  }
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Language, Prisma } from '@prisma/client';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import { PrismaService } from '../../prisma/prisma.service';
import { utcTimestamp } from '../../shared/prisma/utc-timestamp';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { GeoBlockScope } from '../geo-block/dto/geo-block.dto';
import { summarySectionsVisibleWhere } from '../book/book-card';
import { robotsHasNoindex } from '../../shared/seo/term-indexable.util';
import { paginated, type PaginatedResult } from '../../shared/dto/paginated-response.dto';
import { writeUnderSummaryLock } from './book-summary-lock';
import {
  SUMMARY_SECTION_LIMITS,
  type CreateBookSummarySectionDto,
} from './dto/create-book-summary-section.dto';
import type { UpdateBookSummarySectionDto } from './dto/update-book-summary-section.dto';
import type { DeleteBookSummarySectionDto } from './dto/delete-book-summary-section.dto';
import type { ReorderBookSummarySectionsDto } from './dto/reorder-book-summary-sections.dto';
import type {
  BookSummarySectionAdminDto,
  BookSummarySectionCreateResponseDto,
  BookSummarySectionListDto,
  BookSummarySectionListItemDto,
  BookSummarySectionPageDto,
  BookSummarySectionsSitemapItemDto,
  BookSummarySectionUpdateResponseDto,
  BookSummarySectionWarningDto,
} from './dto/book-summary-section-response.dto';

type Actor = { userId: string; email: string } | undefined;
type Db = Prisma.TransactionClient;

/** Номер раздела в адресе — правило `product.md` §3 (то же, что `?chapter=N` читалки). */
const SECTION_NUMBER_PATTERN = /^[1-9]\d{0,5}$/;
/**
 * Предел выборки `Seo` с `noindex` на язык (решение арбитра `F04 | F04-1`, шаг 7 после круга 3): кандидаты
 * собираются в память, поэтому с ограничением строк; дошли до него — отказ, а не урезанный список,
 * который открыл бы закрытые от индекса книги.
 */
export const SITEMAP_NOINDEX_SEO_LIMIT = 10_000;

const LIST_SELECT = {
  id: true,
  number: true,
  title: true,
  readerChapter: true,
  updatedAt: true,
} as const satisfies Prisma.BookSummarySectionSelect;

const ADMIN_SELECT = {
  ...LIST_SELECT,
  text: true,
  movedAt: true,
} as const satisfies Prisma.BookSummarySectionSelect;

type AdminRow = Prisma.BookSummarySectionGetPayload<{ select: typeof ADMIN_SELECT }>;

/**
 * Разделы пересказа версии (F04-1, `books-app-docs/features/F04-summary-variants/tech.md` §2-§4).
 *
 * Номера подряд с 1 держат три операции под замком пересказа версии (T4): добавление в конец,
 * удаление со сдвигом следующих и перестановка. Админка адресует раздел только `id` (T5): номер
 * меняется при удалении и перестановке, и устаревшая вкладка правила бы чужой раздел. `updatedAt`
 * ставит только правка текста, смену номера отмечает `movedAt` (T6).
 *
 * Чтение для читателя — правилом анализа (D4, T8): окончённая претензия закрывает разделы, полный
 * и очень краткий пересказ не трогает; территориальный гео-блок разделы не закрывает.
 */
@Injectable()
export class BookSummarySectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moderatorRoles: ModeratorRolesService,
    private readonly geoBlockRuleService: GeoBlockRuleService,
  ) {}

  /**
   * Оглавление без текстов. Модератору — всегда, и без полного пересказа (админка). Читателю —
   * `[]`, если разделы не видны по правилу счётчика (`summarySectionsVisibleWhere`): страну запроса
   * список не читает, поэтому оглавление на `/summary` одинаково для всех стран и кэша.
   */
  async list(bookVersionId: string, actor: Actor): Promise<BookSummarySectionListDto> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: { status: true },
    });
    if (!version) throw new NotFoundException('BookVersion not found');
    const editor = await this.moderatorRoles.isModerator(actor);
    if (!editor) {
      if (version.status !== 'published') throw new NotFoundException('BookVersion not found');
      const visible = await this.prisma.bookVersion.count({
        where: { id: bookVersionId, ...summarySectionsVisibleWhere(new Date()) },
      });
      if (visible === 0) return { sections: [] };
    }
    return { sections: await listSections(this.prisma, bookVersionId) };
  }

  /**
   * Публичная страница раздела по номеру. Претензия — 451 **до** проверок существования
   * (`product.md` §2 п.7): иначе по 404 и 451 различалось бы, есть ли раздел в стране блока.
   * Дальше: нет полного пересказа с текстом, кривой номер, нет раздела — 404. Модератор проверки
   * претензии и текста не проходит, как у анализа.
   */
  async getByNumber(
    bookVersionId: string,
    rawNumber: string,
    actor: Actor,
    countryCode: string | null,
  ): Promise<BookSummarySectionPageDto> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: { status: true, bookId: true },
    });
    if (!version) throw new NotFoundException('BookVersion not found');

    const editor = await this.moderatorRoles.isModerator(actor);
    if (!editor) {
      if (version.status !== 'published') throw new NotFoundException('BookVersion not found');
      await this.geoBlockRuleService.assertSettledClaimAccess({
        bookId: version.bookId,
        bookVersionId,
        countryCode,
        scope: GeoBlockScope.TEXT_READER,
      });
    }
    if (!SECTION_NUMBER_PATTERN.test(rawNumber)) {
      throw new NotFoundException('Summary section not found');
    }
    const number = Number(rawNumber);

    const [summary, section, toc] = await Promise.all([
      // Запись пересказа на версию одна (`@unique` на `bookVersionId`): `hasText` здесь — тот же признак,
      // что `summaries.some.hasText` у счётчика и карты (`summarySectionsVisibleWhere`).
      this.prisma.bookSummary.findUnique({
        where: { bookVersionId },
        select: { hasText: true, briefHasText: true },
      }),
      this.prisma.bookSummarySection.findUnique({
        where: { bookVersionId_number: { bookVersionId, number } },
        select: ADMIN_SELECT,
      }),
      this.prisma.bookSummarySection.findMany({
        where: { bookVersionId },
        orderBy: { number: 'asc' },
        select: { number: true, title: true },
        take: SUMMARY_SECTION_LIMITS.sectionsPerVersion,
      }),
    ]);
    if (!section || (!editor && !summary?.hasText)) {
      throw new NotFoundException('Summary section not found');
    }
    const readerChapterExists =
      section.readerChapter !== null &&
      (await chapterExists(this.prisma, bookVersionId, section.readerChapter));
    return {
      id: section.id,
      number: section.number,
      title: section.title,
      text: section.text,
      readerChapter: section.readerChapter,
      readerChapterExists,
      contentDate: contentDate(section),
      sections: toc,
      briefHasText: summary?.briefHasText ?? false,
    };
  }

  /** Раздел для админки по `id` — и без полного пересказа. */
  async getById(sectionId: string): Promise<BookSummarySectionAdminDto> {
    const row = await this.prisma.bookSummarySection.findUnique({
      where: { id: sectionId },
      select: ADMIN_SELECT,
    });
    if (!row) throw new NotFoundException('Summary section not found');
    return toAdmin(row);
  }

  /** Раздел в конец: номер «число разделов + 1» под замком (T4); 201-й — 400. */
  async create(
    bookVersionId: string,
    dto: CreateBookSummarySectionDto,
  ): Promise<BookSummarySectionCreateResponseDto> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: { id: true },
    });
    if (!version) throw new NotFoundException('BookVersion not found');

    return this.write(bookVersionId, async (tx) => {
      const count = await tx.bookSummarySection.count({ where: { bookVersionId } });
      if (count >= SUMMARY_SECTION_LIMITS.sectionsPerVersion) {
        throw new BadRequestException(
          `A summary can have at most ${SUMMARY_SECTION_LIMITS.sectionsPerVersion} sections`,
        );
      }
      const now = new Date();
      const row = await tx.bookSummarySection.create({
        data: {
          bookVersionId,
          number: count + 1,
          title: dto.title,
          text: dto.text,
          readerChapter: dto.readerChapter ?? null,
          createdAt: now,
          updatedAt: now,
        },
        select: ADMIN_SELECT,
      });
      return {
        section: toAdmin(row),
        sections: await listSections(tx, bookVersionId),
        warnings: await chapterWarnings(tx, bookVersionId, row.readerChapter),
      };
    });
  }

  /**
   * Правка по `id` (T5): раздел и его версия перечитываются под замком; `expectedUpdatedAt` не равен
   * текущему `updatedAt` — 409. Смена номера (чужое удаление или перестановка) `updatedAt` не
   * трогает, поэтому правку своего раздела не отбивает.
   */
  async update(
    sectionId: string,
    dto: UpdateBookSummarySectionDto,
  ): Promise<BookSummarySectionUpdateResponseDto> {
    const bookVersionId = await this.versionOf(sectionId);
    return this.write(bookVersionId, async (tx) => {
      const current = await tx.bookSummarySection.findUnique({
        where: { id: sectionId },
        select: { updatedAt: true },
      });
      if (!current) throw new NotFoundException('Summary section not found');
      if (current.updatedAt.getTime() !== new Date(dto.expectedUpdatedAt).getTime()) {
        throw new ConflictException('The section was changed by another editor');
      }
      const row = await tx.bookSummarySection.update({
        where: { id: sectionId },
        data: {
          title: dto.title,
          text: dto.text,
          readerChapter: dto.readerChapter,
          updatedAt: new Date(),
        },
        select: ADMIN_SELECT,
      });
      return {
        section: toAdmin(row),
        warnings: await chapterWarnings(tx, bookVersionId, row.readerChapter),
      };
    });
  }

  /**
   * Удаление со сдвигом следующих на 1 вниз (T4). Проверки по порядку (`tech.md` §4): раздела нет —
   * 404; его нет в `from` — 400; `from` не равен текущему порядку — 409.
   */
  async remove(
    bookVersionId: string,
    dto: DeleteBookSummarySectionDto,
  ): Promise<BookSummarySectionListDto> {
    return this.write(bookVersionId, async (tx) => {
      const target = await tx.bookSummarySection.findFirst({
        where: { id: dto.sectionId, bookVersionId },
        select: { number: true },
      });
      if (!target) throw new NotFoundException('Summary section not found');
      if (!dto.from.includes(dto.sectionId)) {
        throw new BadRequestException('sectionId must be listed in from');
      }
      await assertOrder(tx, bookVersionId, dto.from);

      await tx.bookSummarySection.delete({ where: { id: dto.sectionId } });
      // Сдвиг при уникальном `(bookVersionId, number)` — двумя шагами через отрицательные номера:
      // `DEFERRABLE` у индекса Prisma недоступен, а построчная проверка уникальности упала бы
      // на первом же сдвинутом разделе (T4).
      await tx.$executeRaw`UPDATE "BookSummarySection" SET "number" = -"number"
        WHERE "bookVersionId" = ${bookVersionId} AND "number" > ${target.number}`;
      await tx.$executeRaw`UPDATE "BookSummarySection"
        SET "number" = -"number" - 1, "movedAt" = ${utcTimestamp(new Date())}
        WHERE "bookVersionId" = ${bookVersionId} AND "number" < 0`;
      return { sections: await listSections(tx, bookVersionId) };
    });
  }

  /**
   * Перестановка (T4-T6): `to` — не перестановка `from` — 400; `from` не равен текущему порядку — 409.
   * `movedAt` получают только разделы, у которых номер действительно сменился.
   */
  async reorder(
    bookVersionId: string,
    dto: ReorderBookSummarySectionsDto,
  ): Promise<BookSummarySectionListDto> {
    if (!isPermutation(dto.from, dto.to)) {
      throw new BadRequestException('to must contain exactly the ids of from, each once');
    }
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: { id: true },
    });
    if (!version) throw new NotFoundException('BookVersion not found');

    return this.write(bookVersionId, async (tx) => {
      await assertOrder(tx, bookVersionId, dto.from);
      const moved = dto.to
        .map((id, index) => ({ id, number: index + 1 }))
        .filter(({ id }, index) => dto.from[index] !== id);
      if (moved.length > 0) {
        // Первый шаг — отрицательный новый номер всем сменившим его разом (свободен: отрицательных
        // под замком нет), второй — смена знака, как у удаления. Два запроса на любое число разделов.
        const ids = moved.map((m) => m.id);
        const numbers = moved.map((m) => -m.number);
        await tx.$executeRaw`UPDATE "BookSummarySection" AS s SET "number" = v.n
          FROM unnest(${ids}::text[], ${numbers}::int[]) AS v(id, n)
          WHERE s."id" = v.id AND s."bookVersionId" = ${bookVersionId}`;
        await tx.$executeRaw`UPDATE "BookSummarySection"
          SET "number" = -"number", "movedAt" = ${utcTimestamp(new Date())}
          WHERE "bookVersionId" = ${bookVersionId} AND "number" < 0`;
      }
      return { sections: await listSections(tx, bookVersionId) };
    });
  }

  /**
   * Карта разделов языка (T10): элемент — версия со всеми разделами, страница — до 50 версий.
   * Только опубликованные версии языка со слагом и видимыми разделами (правило счётчика), без
   * редакторского `noindex`. Все фильтры — одним `where` для страницы и `total`: иначе короткая
   * страница при полном `total` — отказ `readCompletePage` на фронте.
   */
  async sitemap(
    language: Language,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<BookSummarySectionsSitemapItemDto>> {
    const noindexSeoIds = await this.noindexSeoIds(language);
    // Условия — списком `AND`, а не спредом: общее правило видимости может обзавестись своим `OR`,
    // и спред молча затёр бы одно из двух.
    const where: Prisma.BookVersionWhereInput = {
      AND: [
        { language, status: 'published', slug: { not: null }, summarySections: { some: {} } },
        summarySectionsVisibleWhere(new Date()),
        // `notIn` по nullable-полю отбрасывает строки с `NULL`: версия без `Seo` в карту попадает.
        noindexSeoIds.length > 0
          ? { OR: [{ seoId: null }, { seoId: { notIn: noindexSeoIds } }] }
          : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.bookVersion.findMany({
        where,
        orderBy: { id: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          slug: true,
          summarySections: {
            orderBy: { number: 'asc' },
            take: SUMMARY_SECTION_LIMITS.sectionsPerVersion,
            select: { number: true, updatedAt: true, movedAt: true },
          },
        },
      }),
      this.prisma.bookVersion.count({ where }),
    ]);
    const items = rows.flatMap((row) =>
      row.slug
        ? [
            {
              slug: row.slug,
              sections: row.summarySections.map((s) => ({
                number: s.number,
                lastmod: contentDate(s),
              })),
            },
          ]
        : [],
    );
    return paginated(items, { page, limit, total });
  }

  /**
   * `Seo` версий языка, закрытых от индекса: кандидаты по подстроке, отбор — общим разборщиком
   * `robotsHasNoindex` (решение арбитра `F04 | F04-1`, п.4; предел — шаг 7 после круга 3): одно правило с остальным бэкендом.
   */
  private async noindexSeoIds(language: Language): Promise<number[]> {
    const candidates = await this.prisma.seo.findMany({
      where: {
        bookVersion: { language, status: 'published' },
        OR: [
          { robots: { contains: 'noindex', mode: 'insensitive' } },
          { robots: { contains: 'none', mode: 'insensitive' } },
        ],
      },
      select: { id: true, robots: true },
      orderBy: { id: 'asc' },
      take: SITEMAP_NOINDEX_SEO_LIMIT + 1,
    });
    if (candidates.length > SITEMAP_NOINDEX_SEO_LIMIT) {
      throw new ServiceUnavailableException('Too many noindex pages to build the sitemap');
    }
    return candidates.filter((seo) => robotsHasNoindex(seo.robots)).map((seo) => seo.id);
  }

  /**
   * Запись под замком пересказа версии. Удаление версии идёт мимо замка: снятая каскадом строка
   * (P2025) или FK-отказ (P2003) посреди записи — это 404, а не 500.
   */
  /**
   * Запись разделов под замком пересказа версии (`writeUnderSummaryLock`: удалённая версия — 404).
   * Занятый номер (P2002: номера оказались не подряд мимо сервиса) — 409, а не 500: вкладка просит
   * обновиться (решение арбитра `F04 | F04-1`, края круга 4).
   */
  private async write<T>(
    bookVersionId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await writeUnderSummaryLock(this.prisma, bookVersionId, fn);
    } catch (e: unknown) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('The sections were changed; reload them');
      }
      throw e;
    }
  }

  private async versionOf(sectionId: string): Promise<string> {
    const row = await this.prisma.bookSummarySection.findUnique({
      where: { id: sectionId },
      select: { bookVersionId: true },
    });
    if (!row) throw new NotFoundException('Summary section not found');
    return row.bookVersionId;
  }
}

function listSections(db: Db, bookVersionId: string): Promise<BookSummarySectionListItemDto[]> {
  return db.bookSummarySection.findMany({
    where: { bookVersionId },
    orderBy: { number: 'asc' },
    select: LIST_SELECT,
    take: SUMMARY_SECTION_LIMITS.sectionsPerVersion,
  });
}

/** `from` — порядок, который видел редактор; не совпал с текущим — 409 (T5). */
async function assertOrder(db: Db, bookVersionId: string, from: string[]): Promise<void> {
  const current = await db.bookSummarySection.findMany({
    where: { bookVersionId },
    orderBy: { number: 'asc' },
    select: { id: true },
    take: SUMMARY_SECTION_LIMITS.sectionsPerVersion + 1,
  });
  const same = current.length === from.length && current.every((row, i) => row.id === from[i]);
  if (!same) throw new ConflictException('The sections were changed by another editor');
}

function isPermutation(from: string[], to: string[]): boolean {
  if (from.length !== to.length || new Set(to).size !== to.length) return false;
  const known = new Set(from);
  return to.every((id) => known.has(id));
}

/** Точечный запрос по `@@unique([bookVersionId, number])` главы (T7), без выборки всех номеров. */
async function chapterExists(db: Db, bookVersionId: string, number: number): Promise<boolean> {
  const chapter = await db.chapter.findUnique({
    where: { bookVersionId_number: { bookVersionId, number } },
    select: { id: true },
  });
  return chapter !== null;
}

/** Несуществующая глава читалки — не отказ, а предупреждение: ссылки «Читать эту главу» не будет. */
async function chapterWarnings(
  db: Db,
  bookVersionId: string,
  readerChapter: number | null,
): Promise<BookSummarySectionWarningDto[]> {
  if (readerChapter === null || (await chapterExists(db, bookVersionId, readerChapter))) return [];
  return [
    {
      code: 'chapter_not_found',
      path: 'readerChapter',
      message: `chapter ${readerChapter} is not in this version; the "Read this chapter" link will not be shown`,
    },
  ];
}

/** Дата адреса раздела (T6): позднейшая из правки текста и смены номера. */
function contentDate(row: { updatedAt: Date; movedAt: Date | null }): Date {
  return row.movedAt && row.movedAt > row.updatedAt ? row.movedAt : row.updatedAt;
}

function toAdmin(row: AdminRow): BookSummarySectionAdminDto {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    text: row.text,
    readerChapter: row.readerChapter,
    updatedAt: row.updatedAt,
    contentDate: contentDate(row),
  };
}

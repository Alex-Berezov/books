import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Language, Prisma } from '@prisma/client';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GeoBlockRuleService } from '../geo-block/geo-block-rule.service';
import { GeoBlockScope } from '../geo-block/dto/geo-block.dto';
import { getSupportedLanguages } from '../../shared/language/language.util';
import { pickSlugOwner } from '../../shared/slug/book-slug-owner';
import {
  BOOK_ANALYSIS_SELECT,
  EMPTY_BOOK_ANALYSIS,
  mergeAnalysis,
  readStoredAnalysis,
  toAnalysisWrite,
  type StoredBookAnalysis,
} from './book-analysis-data';
import { computeAnalysisCore } from './book-analysis-core';
import { checkAnalysisRefs, collectChapterRefs } from './book-analysis-refs';
import { ClaimBlockScope } from '../rights-claims/rights-claim-interface';
import { settledClaimBlockWhere } from '../rights-claims/settled-claim-block';
import type { UpdateBookAnalysisDto } from './dto/update-book-analysis.dto';
import type {
  BookAnalysisClaimClosureDto,
  BookAnalysisClaimClosuresResponseDto,
  BookAnalysisResponseDto,
  BookAnalysisSaveResponseDto,
  BookAnalysisWarningDto,
} from './dto/book-analysis-response.dto';

// Пространство имён двухаргументного `pg_advisory_xact_lock`; занятые — в перечне у `RECHECK_SCAN_LOCK_KEY`.
const BOOK_ANALYSIS_LOCK_NAMESPACE = 831_427_006;
// Явные границы (`L-020`): писатель, дождавшийся замка, не должен падать P2028 на дефолтных 5 секундах.
const BOOK_ANALYSIS_TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;
/** Порция списка закрытий анализа (`listClaimClosures`, порог `id > последний`) и предел порций - граница памяти. */
export const CLAIM_CLOSURES_BATCH = 1000;
export const CLAIM_CLOSURES_MAX_BATCHES = 20;
/**
 * Предел выборки номеров глав (`chapterNumbers`): тот же, что у списка названий глав админки
 * (`chapter-titles`, 5 000). Выборка целиком в память идёт с ограничением строк.
 */
export const CHAPTER_NUMBERS_LIMIT = 5000;

type AnalysisRow = Prisma.BookAnalysisGetPayload<{ select: typeof BOOK_ANALYSIS_SELECT }>;

@Injectable()
export class BookAnalysisService {
  constructor(
    private prisma: PrismaService,
    private readonly moderatorRoles: ModeratorRolesService,
    private readonly geoBlockRuleService: GeoBlockRuleService,
  ) {}

  /**
   * Публичное чтение и чтение вкладки админки — один адрес, как у пересказа: черновик версии
   * анониму — 404, редактору — запись; анализ без ядра анониму — `null`.
   *
   * Территориального гео-блока нет: анализ — сведения о книге, собственный текст Bibliaris
   * с короткими цитатами (решение владельца 18.10.2026 по А1, ADR-012 п.7 «карточка»).
   * Блок претензии правообладателя закрывает анализ, только когда спор окончен; пока
   * разбирательство идёт, анализ открыт, хотя текст версии закрыт (слово владельца 18.10.2026,
   * `work-queue.md` «ВЛАДЕЛЕЦ» п.6; перевод на статусы — решение арбитра в `decisions-log.md`).
   * Редактор проверку не проходит.
   */
  async getByVersion(
    bookVersionId: string,
    actor: { userId: string; email: string } | undefined,
    countryCode: string | null,
  ): Promise<BookAnalysisResponseDto | null> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: { status: true, language: true, bookId: true },
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

    // Номера глав читаются параллельно с анализом (F03-3): на ответе `null` запрос глав лишний,
    // но дешевле второго последовательного обхода базы на каждом читаемом анализе.
    const [row, chapterNumbers] = await Promise.all([
      this.prisma.bookAnalysis.findUnique({
        where: { bookVersionId },
        select: BOOK_ANALYSIS_SELECT,
      }),
      loadChapterNumbers(this.prisma, bookVersionId),
    ]);
    // Без ядра анализа для читателя нет (`product.md` §2): незаконченные блоки видит только редактор.
    if (!row || (!editor && !row.hasCore)) return null;
    return toResponse(row, version.language, chapterNumbers);
  }

  /**
   * Где анализ закрыт блоком окончённой претензии — для middleware фронта (решение арбитра
   * `F03 | F03-2`). Страница анализа рендерится статично без страны читателя, поэтому блок по
   * стране закрывает её middleware по этому списку; условие блока — то же, что у ручки
   * `getByVersion` и счётчика `_count.analyses` (`settledClaimBlockWhere`).
   *
   * Элемент один на опубликованную версию и её язык (`language` всегда задан): блок на всю книгу даёт
   * элемент на каждую её версию, блок версии — на неё одну; слаги — по правилу `toClaimClosure`.
   * Только опубликованные версии: черновик и без того 404. Срок отдаётся, чтобы middleware не
   * держал истёкший блок до следующего обновления списка.
   */
  async listClaimClosures(): Promise<BookAnalysisClaimClosuresResponseDto> {
    const where = settledClaimBlockWhere(new Date(), ClaimBlockScope.TEXT_READER);
    const items: BookAnalysisClaimClosuresResponseDto['items'] = [];
    let cursor: string | undefined;
    // Список читается целиком, порциями: обрезанный список middleware не отличил бы от полного
    // и открыл бы анализ в стране блока (L-015). Предел порций - граница памяти; дошли до него -
    // отказ, и middleware работает по прежнему списку, а не по урезанному.
    // Предел проверяется после чтения: ровно `MAX_BATCHES` полных порций - ещё полный список, отказ
    // только если за ними есть хоть одна строка.
    for (let batch = 0; batch <= CLAIM_CLOSURES_MAX_BATCHES; batch += 1) {
      const take = batch === CLAIM_CLOSURES_MAX_BATCHES ? 1 : CLAIM_CLOSURES_BATCH;
      // Порог `id > последний`, а не курсор Prisma: курсор ищет свою строку, и удалённая каскадом
      // между порциями строка дала бы пустую порцию - урезанный список под видом конца.
      const blocks = await this.prisma.rightsClaimAccessBlock.findMany({
        where: cursor ? { AND: [where, { id: { gt: cursor } }] } : where,
        select: CLAIM_CLOSURE_SELECT,
        orderBy: { id: 'asc' },
        take,
      });
      if (batch === CLAIM_CLOSURES_MAX_BATCHES) {
        if (blocks.length > 0) {
          throw new ServiceUnavailableException('Too many claim closures to list');
        }
        return { items };
      }
      const candidates = blocks.flatMap(toClaimClosureCandidates);
      const owners = await loadSlugOwners(
        this.prisma,
        candidates.flatMap((c) => c.slugs),
      );
      for (const candidate of candidates) {
        const closure = toClaimClosure(candidate, owners);
        if (closure.slugs.length > 0) items.push(closure);
      }
      if (blocks.length < CLAIM_CLOSURES_BATCH) return { items };
      cursor = blocks[blocks.length - 1].id;
    }
    return { items };
  }

  /**
   * Запись под advisory-замком по версии: «прочитал — слил — записал» не теряет блок второго
   * писателя. `dryRun` (решение А3) проходит ту же проверку и слияние без замка и без записи.
   */
  async saveForVersion(
    bookVersionId: string,
    dto: UpdateBookAnalysisDto,
    dryRun: boolean,
  ): Promise<BookAnalysisSaveResponseDto> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: { language: true },
    });
    if (!version) throw new NotFoundException('BookVersion not found');
    if (dto.language !== version.language) {
      throw new BadRequestException(
        `language: JSON is "${dto.language}", the version is "${version.language}"`,
      );
    }

    if (dryRun) {
      const existing = await this.prisma.bookAnalysis.findUnique({
        where: { bookVersionId },
        select: BOOK_ANALYSIS_SELECT,
      });
      const merged = this.validateMerged(existing, dto);
      return { analysis: null, ...(await this.describe(this.prisma, bookVersionId, merged)) };
    }

    let saved: { row: AnalysisRow; hasCore: boolean; warnings: BookAnalysisWarningDto[] };
    try {
      saved = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT true AS locked
          FROM pg_advisory_xact_lock(${BOOK_ANALYSIS_LOCK_NAMESPACE}::int4, hashtext(${bookVersionId}::text))`;
        const existing = await tx.bookAnalysis.findUnique({
          where: { bookVersionId },
          select: BOOK_ANALYSIS_SELECT,
        });
        const merged = this.validateMerged(existing, dto);
        const summary = await this.describe(tx, bookVersionId, merged);
        const data = { ...toAnalysisWrite(merged), hasCore: summary.hasCore };
        const row = existing
          ? await tx.bookAnalysis.update({
              where: { bookVersionId },
              data,
              select: BOOK_ANALYSIS_SELECT,
            })
          : await tx.bookAnalysis.create({
              data: { bookVersionId, ...data },
              select: BOOK_ANALYSIS_SELECT,
            });
        return { row, ...summary };
      }, BOOK_ANALYSIS_TX_OPTIONS);
    } catch (e: unknown) {
      // Версию проверяли до транзакции и без замка: удалённая в этом окне версия даёт FK-отказ
      // на create (P2003) или снятую каскадом строку на update (P2025) — это 404.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        (e.code === 'P2003' || e.code === 'P2025')
      ) {
        throw new NotFoundException('BookVersion not found');
      }
      throw e;
    }
    // Номера глав — после коммита и вне замка (F03-3): замок держит только «прочитал — слил —
    // записал», чтение глав версии запись не защищает и замок не удлиняет.
    const { row, ...summary } = saved;
    const chapterNumbers = await loadChapterNumbers(this.prisma, bookVersionId);
    return { analysis: toResponse(row, version.language, chapterNumbers), ...summary };
  }

  private validateMerged(existing: AnalysisRow | null, dto: UpdateBookAnalysisDto) {
    const merged = mergeAnalysis(
      existing ? readStoredAnalysis(existing) : EMPTY_BOOK_ANALYSIS,
      dto,
    );
    const errors = checkAnalysisRefs(merged);
    if (errors.length > 0) {
      throw new BadRequestException(errors.map((e) => `${e.path}: ${e.message}`));
    }
    return merged;
  }

  /** Ядро и предупреждения слитой записи: ненайденные главы (T4) и чего не хватает до ядра. */
  private async describe(
    db: Prisma.TransactionClient,
    bookVersionId: string,
    merged: StoredBookAnalysis,
  ): Promise<{ hasCore: boolean; warnings: BookAnalysisWarningDto[] }> {
    const warnings: BookAnalysisWarningDto[] = [];
    const refs = collectChapterRefs(merged);
    if (refs.length > 0) {
      // Только упомянутые номера (их не больше лимитов блоков): выборка всех глав с пределом
      // давала бы ложное «нет главы» на версии длиннее предела.
      const chapters = await db.chapter.findMany({
        where: { bookVersionId, number: { in: [...new Set(refs.map((r) => r.chapter))] } },
        select: { number: true },
      });
      const known = new Set(chapters.map((c) => c.number));
      for (const ref of refs) {
        if (!known.has(ref.chapter)) {
          warnings.push({
            code: 'chapter_not_found',
            path: ref.path,
            message: `chapter ${ref.chapter} is not in this version; the link will not be shown`,
          });
        }
      }
    }
    const core = computeAnalysisCore(merged);
    for (const m of core.missing) {
      warnings.push({
        code: 'core_incomplete',
        path: m.part,
        message:
          m.part === 'mainIdea'
            ? 'mainIdea is empty; the page will not be published'
            : `${m.part}: ${m.have} of ${m.need} filled; the page will not be published`,
      });
    }
    return { hasCore: core.hasCore, warnings };
  }
}

/** Слаги и языки опубликованных версий книги - из них собираются её адреса. */
const PUBLISHED_VERSION_SLUGS = {
  where: { status: 'published' },
  // Порядок задан: без него порядок элементов и слагов в ответе плавает от плана запроса (LEGACY-375).
  orderBy: { language: 'asc' },
  select: { slug: true, language: true },
} as const satisfies Prisma.Book$versionsArgs;

/** Поля блока для списка закрытий: только цель, страна и срок - без причины и претензии. */
const CLAIM_CLOSURE_SELECT = {
  id: true,
  scope: true,
  countryCode: true,
  expiresAt: true,
  book: {
    select: {
      id: true,
      slug: true,
      versions: PUBLISHED_VERSION_SLUGS,
    },
  },
  bookVersion: {
    select: {
      language: true,
      status: true,
      book: { select: { id: true, slug: true, versions: PUBLISHED_VERSION_SLUGS } },
    },
  },
} as const satisfies Prisma.RightsClaimAccessBlockSelect;

type ClaimClosureRow = Prisma.RightsClaimAccessBlockGetPayload<{
  select: typeof CLAIM_CLOSURE_SELECT;
}>;

/**
 * Закрываемая версия: её язык и все слаги, по которым может открыться страница книги, - `Book.slug`
 * и слаги её опубликованных версий на любом языке. Какие из них ведут на эту книгу в языке версии,
 * решает `toClaimClosure`.
 */
interface ClaimClosureCandidate {
  bookId: string;
  language: Language;
  slugs: string[];
  countryCode: string | null;
  expiresAt: Date | null;
}

/**
 * Версии, которые закрывает блок. Блок на всю книгу закрывает каждую её опубликованную версию, но
 * только книги с опубликованной версией: слаг книги без единой опубликованной версии - непубличный
 * адрес, и вместе с ним наружу ушёл бы факт претензии. Блок версии - только опубликованной.
 */
function toClaimClosureCandidates(block: ClaimClosureRow): ClaimClosureCandidate[] {
  const countryCode = block.countryCode ? block.countryCode.toUpperCase() : null;
  const candidate = (
    book: { id: string; slug: string; versions: Array<{ slug: string | null }> },
    language: Language,
  ): ClaimClosureCandidate => ({
    bookId: book.id,
    language,
    slugs: uniqueSlugs([book.slug, ...book.versions.map((version) => version.slug)]),
    countryCode,
    expiresAt: block.expiresAt,
  });
  if (block.scope === ClaimBlockScope.ENTIRE_BOOK && block.book) {
    const book = block.book;
    return book.versions.map((version) => candidate(book, version.language));
  }
  if (block.bookVersion && block.bookVersion.status === 'published') {
    return [candidate(block.bookVersion.book, block.bookVersion.language)];
  }
  return [];
}

type SlugOwners = Map<string, Array<{ language: Language; bookId: string }>>;

/**
 * Опубликованные версии с этими слагами на любом языке, по слагу; внутри слага - по `language asc`,
 * как запасной поиск `getOverview`. Один запрос на порцию.
 *
 * 🔴 `language: { in: ... }` - у `BookVersion` нет индекса с ведущим `slug`, только
 * `@@unique([language, slug])`; без языка запрос читает таблицу целиком (как у `isBookSlugLive`).
 */
async function loadSlugOwners(
  client: Prisma.TransactionClient,
  slugs: string[],
): Promise<SlugOwners> {
  const owners: SlugOwners = new Map();
  const unique = [...new Set(slugs)];
  if (unique.length === 0) return owners;
  const rows = await client.bookVersion.findMany({
    where: { status: 'published', slug: { in: unique }, language: { in: getSupportedLanguages() } },
    orderBy: { language: 'asc' },
    select: { slug: true, language: true, bookId: true },
  });
  for (const row of rows) {
    if (!row.slug) continue;
    const list = owners.get(row.slug) ?? [];
    list.push({ language: row.language, bookId: row.bookId });
    owners.set(row.slug, list);
  }
  return owners;
}

/**
 * Слаги, по которым `/{language}/book/{slug}/analysis` открывает именно эту книгу. Порядок - как
 * у `BookService.getOverview`: опубликованная версия с этим слагом в языке адреса, затем такая же
 * в любом языке (первая по `language asc`), затем `Book.slug`. Слаг, который по этому порядку
 * достаётся другой книге, не отдаётся: middleware сверяет только слаг и язык, и чужой адрес получил
 * бы ложный 451. Слаг версии уникален лишь в паре с языком, `Book.slug` - глобально (пачка F03-2f).
 */
function toClaimClosure(
  candidate: ClaimClosureCandidate,
  owners: SlugOwners,
): BookAnalysisClaimClosureDto {
  const ownerOf = (slug: string): string => {
    const match = pickSlugOwner(owners.get(slug) ?? [], candidate.language);
    // Опубликованной версии с этим слагом нет нигде - адрес отвечает `Book.slug` этой книги.
    return match ? match.bookId : candidate.bookId;
  };
  return {
    slugs: candidate.slugs.filter((slug) => ownerOf(slug) === candidate.bookId),
    language: candidate.language,
    countryCode: candidate.countryCode,
    expiresAt: candidate.expiresAt,
  };
}

function uniqueSlugs(slugs: Array<string | null>): string[] {
  return [...new Set(slugs.filter((slug): slug is string => Boolean(slug)))];
}

/**
 * Номера глав версии — чтобы страница ставила ссылку «глава N» только на существующую главу
 * (`product.md` §1.6, решение арбитра `F03 | F03-2`). Только `number`: ни заголовков, ни текста.
 */
async function loadChapterNumbers(
  db: Prisma.TransactionClient,
  bookVersionId: string,
): Promise<number[]> {
  const chapters = await db.chapter.findMany({
    where: { bookVersionId },
    select: { number: true },
    orderBy: { number: 'asc' },
    take: CHAPTER_NUMBERS_LIMIT,
  });
  return chapters.map((chapter) => chapter.number);
}

function toResponse(
  row: AnalysisRow,
  language: BookAnalysisResponseDto['language'],
  chapterNumbers: number[],
): BookAnalysisResponseDto {
  return {
    language,
    hasCore: row.hasCore,
    chapterNumbers,
    ...readStoredAnalysis(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

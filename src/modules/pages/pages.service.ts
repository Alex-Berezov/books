import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AdminAuditAction,
  AdminAuditTargetType,
  Language,
  Page,
  Prisma,
  PublicationStatus,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePageDto } from './dto/create-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { isReservedSlug, RESERVED_SLUG_MESSAGE } from '../../shared/constants/reserved-slugs';
import { SlugRedirectService } from '../slug-redirect/slug-redirect.service';
import { AdminAuditService } from '../../shared/admin-audit/admin-audit.service';
import { paginated } from '../../shared/dto/paginated-response.dto';
import {
  foreignKeyViolationTargets,
  uniqueViolationFields,
  violationModelName,
} from '../../shared/prisma/prisma-error.util';
import { deleteSeoIfUnreferenced, seoOwnersCount } from '../../shared/seo/seo-orphan.util';

/**
 * Точная форма, которую реально возвращает Prisma с `include: { seo: true }` — используется как
 * настоящий тип возврата вместо `any` в `pages.controller.ts` (Q6, `LEGACY-016`/`LEGACY-183`).
 * `PageResponse` (Swagger DTO) описывает ту же форму для документации отдельно: сверять TS-тип
 * с ней напрямую нельзя, у неё `faq`/`sections` заужены до `Record<string, unknown> | null`,
 * а Prisma отдаёт `JsonValue`.
 */
type PageWithSeo = Prisma.PageGetPayload<{ include: { seo: true } }>;

/**
 * `%` и `_` в запросе пользователя — это символы, а не подстановки; та же
 * причина и то же экранирование, что в `author.service.ts` (там оно называется
 * так же и не переиспользовано специально — сравнение с общим местом не входило
 * в границы `LEGACY-371`).
 */
function escapeLikeWildcards(term: string): string {
  return term.replace(/([\\%_])/g, '\\$1');
}

/**
 * Границы транзакции смены видимости (`LEGACY-015`, пачка `T21`). Те же цифры, что
 * у удаления страницы выше, и по той же причине (`L-020`).
 *
 * ⚠️ Транзакции здесь не было вовсе — `setStatus` шёл парой `findUnique` + `update`
 * по корневому клиенту. Заведена она ради атомарности записи в журнал (`LEGACY-036`),
 * а **не** ради закрытия гонки: `SELECT ... FOR UPDATE` на строку страницы решением
 * арбитра 20.09.2026 в эту пачку не берётся (`decisions-log.md`). Признак изменения
 * состояния даёт не замок и не сравнение в коде, а сама условная запись — см.
 * `setStatus` ниже.
 *
 * Те же границы у `update()` и `create()` (`LEGACY-400`, пачка `T55`): обе открывают
 * интерактивную транзакцию, и дефолтные 2 с ожидания соединения давали бы `P2024`
 * под нагрузкой пула. Ими же идёт `remove()` (`LEGACY-395`, прежняя `PAGE_REMOVE_TX_OPTIONS` с теми же
 * цифрами слита сюда в `T55b`). Поэтому имя — про запись страницы, а не про видимость.
 */
const PAGE_WRITE_TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;

/**
 * Один текст на обе стороны отказа — свою проверку дубля и `P2002` от базы, — как
 * `CATEGORY_SLUG_TAKEN_MESSAGE` у категорий (`LEGACY-311`): оператор видит одно сообщение
 * на одно событие, кто бы его ни поймал.
 */
const PAGE_SLUG_TAKEN_MESSAGE = 'Page with same slug already exists for this language';

/** Тот же приём для `seoId`: своя проверка владельцев и `P2002` по `Page.seoId` — один текст. */
const PAGE_SEO_TAKEN_MESSAGE = 'SEO entity is already attached to another entity';

/** И для «строки `Seo` нет»: своя проверка и `P2003` по `Page_seoId_fkey` (строку удалили в окне). */
const PAGE_SEO_MISSING_MESSAGE = 'Invalid seoId: referenced SEO entity does not exist';

/**
 * 🔴 `LEGACY-320`, тема владельца 3 (решение владельца 27.09.2026). Язык существующей страницы
 * не меняется: перевод — отдельная страница той же `translationGroupId`. Редирект слага живёт
 * в одном языке (`SlugRedirect` без языка назначения), и смена языка оставляла старый адрес
 * 404 либо писала 308 на несуществующий адрес. Админка поле языка у существующей страницы
 * и так отключает — запрет на API закрывает прямой вызов.
 */
const PAGE_LANGUAGE_IMMUTABLE_MESSAGE =
  'Page language cannot be changed after creation; create a translation instead';

@Injectable()
export class PagesService {
  constructor(
    private prisma: PrismaService,
    private slugRedirects: SlugRedirectService,
    private adminAudit: AdminAuditService,
  ) {}

  async getPublicBySlug(slug: string, language?: Language) {
    const where = language
      ? { slug, language, status: 'published' as const }
      : { slug, status: 'published' as const };
    const page = await this.prisma.page.findFirst({
      where,
      include: { seo: true },
    });
    if (!page) throw new NotFoundException('Page not found');
    return page;
  }

  /**
   * Resolves a page the site looks up for itself — the homepage and the four
   * taxonomy hubs — by its immutable key instead of its slug.
   *
   * The slug used to be the address, and it is generated from the title in the
   * admin form: renaming the title rewrote it and severed the link without an
   * error anywhere. `systemKey` is not editable, so the same rename now only
   * moves the page's public URL.
   *
   * No cross-language fallback here, deliberately, and for the same reason as
   * `getPublicBySlug`: a hub answering in the wrong language is worse than a
   * hub answering from its own fallback text, because it is indexable.
   */
  async getPublicBySystemKey(systemKey: string, language: Language) {
    const page = await this.prisma.page.findFirst({
      where: { systemKey, language, status: 'published' },
      include: { seo: true },
    });
    if (!page) throw new NotFoundException('Page not found');
    return page;
  }

  async adminList(page = 1, limit = 20, language?: Language) {
    const skip = (page - 1) * limit;
    const where = language ? { language } : undefined;

    const [data, total] = await Promise.all([
      this.prisma.page.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { seo: true },
      }),
      this.prisma.page.count({ where }),
    ]);

    // Единая форма списка (`LEGACY-177`): метод зовёт только админский
    // `GET /admin/:lang/pages` (`pages.controller.ts`), публичная страница
    // отдаётся поштучно `getPublicBySlug` из `PublicController`
    // (`GET /:lang/pages/:slug`) — кэшируемых ответов эта замена не касается.
    return paginated(data, { page, limit, total });
  }

  async adminListGrouped(page = 1, limit = 20, search?: string, status?: PublicationStatus) {
    const skip = (page - 1) * limit;

    // Фильтр стоит на уровне отдельной страницы (Page), а не группы: группа
    // проходит в выдачу, если хотя бы один её перевод совпадает с поиском
    // и статусом. `groupBy` агрегирует только строки, прошедшие `where`, —
    // группа без единого совпадения в выдаче не появится вовсе, а фильтр
    // не сужает список переводов внутри уже отобранной группы (второй запрос
    // ниже читает их снова, без `where`).
    const term = search?.trim();
    const where: Prisma.PageWhereInput = {
      translationGroupId: { not: null },
      ...(term
        ? {
            OR: [
              { title: { contains: escapeLikeWildcards(term), mode: 'insensitive' as const } },
              { slug: { contains: escapeLikeWildcards(term), mode: 'insensitive' as const } },
            ],
          }
        : {}),
      ...(status ? { status } : {}),
    };

    // 1. Get unique translationGroupIds (pagination base)
    // We only consider pages that have a translationGroupId.
    // Pages without it (legacy) should ideally be migrated, but here we'll just ignore them or handle separately if needed.
    // For now, assuming migration filled them or they are new.
    const groups = await this.prisma.page.groupBy({
      by: ['translationGroupId'],
      where,
      _max: { updatedAt: true },
      orderBy: {
        _max: { updatedAt: 'desc' },
      },
      skip,
      take: limit,
    });

    const totalGroups = (
      await this.prisma.page.groupBy({
        by: ['translationGroupId'],
        where,
      })
    ).length;

    // 2. Fetch all pages for these groups
    const groupIds = groups
      .map((g): string | null => g.translationGroupId)
      .filter((id): id is string => id !== null);

    const pages = await this.prisma.page.findMany({
      where: {
        translationGroupId: { in: groupIds },
      },
      include: { seo: true },
      orderBy: { language: 'asc' }, // Consistent order within group
    });

    // 3. Group them in memory
    const groupedData = groupIds.map((groupId) => ({
      translationGroupId: groupId,
      pages: pages.filter((p) => p.translationGroupId === groupId),
    }));

    // Единая форма списка (`LEGACY-177`); как и `adminList`, метод обслуживает
    // один-единственный админский маршрут `GET /admin/pages`.
    return paginated(groupedData, { page, limit, total: totalGroups });
  }

  async findById(id: string) {
    const page = await this.prisma.page.findUnique({
      where: { id },
      include: { seo: true },
    });
    if (!page) throw new NotFoundException('Page not found');

    let translations: { id: string; language: Language; slug: string; title: string }[] = [];
    if (page.translationGroupId) {
      translations = await this.prisma.page.findMany({
        where: {
          translationGroupId: page.translationGroupId,
          id: { not: page.id },
        },
        select: {
          id: true,
          language: true,
          slug: true,
          title: true,
        },
      });
    }

    return { ...page, translations };
  }

  async create(dto: CreatePageDto, language: Language): Promise<PageWithSeo> {
    // Before anything is written: a reserved slug is not a page with a bad name,
    // it is a page with no address — the router answers that path first.
    if (isReservedSlug(dto.slug)) throw new BadRequestException(RESERVED_SLUG_MESSAGE);

    const translationGroupId = dto.translationGroupId || randomUUID();

    try {
      // 🔴 `LEGACY-400`: `Seo` пишется той же транзакцией, что и страница, — до этой
      // правки создание страницы шло на пуле уже ПОСЛЕ `Seo`, и отказ вставки страницы
      // (например, дубль `(language, slug)`, `P2002` ниже) оставлял `Seo` сиротой,
      // которую ничто больше не найдёт (тот же приём, что у `CategoryService.updateTranslation`
      // после `T54`).
      return await this.prisma.$transaction(async (tx) => {
        // Legacy-`seoId` проверяется всегда, когда прислан, — и вместе с `seo` тоже: иначе
        // `{ seo: {}, seoId }` проносил бы чужое `Seo` мимо проверки (`LEGACY-400`, `T55b`).
        // Непустой `seo` дальше побеждает; пустой оставляет прежнее поведение — привязку `seoId`.
        if (dto.seoId !== undefined && dto.seoId !== null) {
          await this.assertSeoAttachable(tx, dto.seoId);
        }
        let finalSeoId = dto.seoId;
        if (dto.seo) {
          // Check if SEO fields are not all null/undefined
          const hasSeoData = Object.values(dto.seo).some((v) => v !== null && v !== undefined);
          if (hasSeoData) {
            const newSeo = await tx.seo.create({ data: dto.seo });
            finalSeoId = newSeo.id;
          }
        }

        const pageInput: Prisma.PageUncheckedCreateInput = {
          slug: dto.slug,
          title: dto.title,
          type: dto.type,
          content: dto.content,
          h1: dto.h1 ?? null,
          shortDescription: dto.shortDescription ?? null,
          // `FaqItemDto[]` из DTO — экземпляры класса, а не `InputJsonObject`; та же граница,
          // что у `sections` строкой ниже.
          faq: (dto.faq as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          // `Record<string, unknown>` из DTO описывает произвольный объект блоков, а Prisma ждёт
          // `InputJsonValue`: значения `unknown` в неё не проходят. Граница ровно здесь.
          sections: (dto.sections as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          language,
          status: 'draft' as const,
          seoId: finalSeoId,
          translationGroupId,
        };
        return tx.page.create({
          data: pageInput,
          include: { seo: true },
        });
      }, PAGE_WRITE_TX_OPTIONS);
    } catch (e) {
      throw pageWriteError(e);
    }
  }

  /**
   * ⚠️ `actorUserId` обязателен, хотя журналируется здесь только одно поле формы —
   * `status`. Умолчания нет намеренно: оно сняло бы единственную машинную гарантию,
   * что актёр доехал от контроллера до записи (`LEGACY-015`, пачка `T21`).
   */
  async update(id: string, dto: UpdatePageDto, actorUserId: string): Promise<PageWithSeo> {
    try {
      // Слаг страницы — её публичный адрес. С тех пор как системные страницы ищутся
      // по неизменяемому `systemKey` (09.08.2026), слаг стал обычным редактируемым
      // полем — то есть его смена больше ничего не ломает функционально и ровно
      // поэтому обязана оставлять 308 (LEGACY-062).
      return await this.prisma.$transaction(async (tx) => {
        // 🔴 `LEGACY-320`/`LEGACY-400`. Слаг, язык и `seoId` берутся ОДНИМ locked-запросом,
        // а не снимком `exists` на пуле до транзакции: до этой правки проверка дубля
        // (language, slug) и запись `Seo` шли по устаревшему снимку и вне транзакции
        // страницы. Встречная смена слага, закоммиченная между чтением и записью,
        // оставляла старый адрес без редиректа (`L-019`); отказ записи страницы уже после
        // отдельного `Seo`-запроса оставлял его сиротой. Проверка дубля ниже гонку
        // не закрывает — замок держит только свою строку, чужую вставку той же пары
        // `findFirst` не видит; рубеж — уникальный индекс, его `P2002` разбирается в `catch`.
        const [locked] = await tx.$queryRaw<Pick<Page, 'slug' | 'language' | 'seoId'>[]>`
          SELECT slug, language, "seoId" FROM "Page" WHERE id = ${id} FOR NO KEY UPDATE`;
        if (!locked) throw new NotFoundException('Page not found');

        // Тот же язык, присланный формой целиком, — не смена (`PAGE_LANGUAGE_IMMUTABLE_MESSAGE`).
        // `null` проходит `@IsOptional` и значит «не прислано», а не «сменить на пустой».
        if (dto.language != null && dto.language !== locked.language) {
          throw new BadRequestException(PAGE_LANGUAGE_IMMUTABLE_MESSAGE);
        }

        if (dto.slug) {
          // Renaming *into* a reserved slug is worse than creating one: the old
          // address gets a `SlugRedirect` pointing at a path the router will never
          // hand to a page, so the redirect built to preserve the URL would strand
          // the visitor.
          //
          // Only an actual move is refused. A page that already sits on a reserved
          // slug predates this rule, and blocking it would brick the very form its
          // owner needs to rename it — the edit form submits the whole record, so an
          // unchanged slug arrives in `dto` like any other field. Renaming away stays
          // open, which is the way out.
          if (dto.slug !== locked.slug && isReservedSlug(dto.slug)) {
            throw new BadRequestException(RESERVED_SLUG_MESSAGE);
          }
          const dup = await tx.page.findFirst({
            where: { slug: dto.slug, language: locked.language, NOT: { id } },
            select: { id: true },
          });
          if (dup) throw new BadRequestException(PAGE_SLUG_TAKEN_MESSAGE);
        }

        // Handle SEO: if dto.seo is provided, create or update SEO entity
        // Legacy-`seoId` проверяется всегда, когда прислан, — и вместе с `seo` тоже: иначе
        // `{ seo: {}, seoId }` проносил бы чужое `Seo` мимо проверки (`LEGACY-400`, `T55b`).
        if (dto.seoId !== undefined && dto.seoId !== null && dto.seoId !== locked.seoId) {
          await this.assertSeoAttachable(tx, dto.seoId);
        }
        let finalSeoId = dto.seoId;
        if (dto.seo) {
          // Check if SEO fields are not all null/undefined
          const hasSeoData = Object.values(dto.seo).some((v) => v !== null && v !== undefined);
          if (hasSeoData) {
            if (locked.seoId) {
              // Update existing SEO entity
              await tx.seo.update({
                where: { id: locked.seoId },
                data: dto.seo,
              });
              finalSeoId = locked.seoId;
            } else {
              // Create new SEO entity
              const newSeo = await tx.seo.create({
                data: dto.seo,
              });
              finalSeoId = newSeo.id;
            }
          } else if (locked.seoId) {
            // All SEO fields are null - detach SEO entity
            finalSeoId = null;
          }
        }

        const updateInput: Record<string, unknown> = {};
        if (dto.slug !== undefined) updateInput.slug = dto.slug;
        if (dto.title !== undefined) updateInput.title = dto.title;
        if (dto.type !== undefined) updateInput.type = dto.type;
        if (dto.content !== undefined) updateInput.content = dto.content;
        if (dto.h1 !== undefined) updateInput.h1 = dto.h1;
        if (dto.shortDescription !== undefined) updateInput.shortDescription = dto.shortDescription;
        if (dto.faq !== undefined) updateInput.faq = dto.faq ?? Prisma.JsonNull;
        if (dto.sections !== undefined) updateInput.sections = dto.sections ?? Prisma.JsonNull;
        if (finalSeoId !== undefined) updateInput.seoId = finalSeoId;
        // `status` в `updateInput` намеренно **не** кладётся: смена публичной видимости
        // журналируется, и признак изменения даёт отдельная условная запись ниже.
        // Положить его сюда значило бы вернуть безусловный апдейт, на котором отличить
        // «опубликовали» от «нажали второй раз» уже нечем (`LEGACY-015`, пачка `T21`).

        // Язык страницы неизменяем (выше), поэтому старый и новый адрес живут в одном языке.
        if (dto.slug && dto.slug !== locked.slug) {
          await this.slugRedirects.record(
            {
              entityType: 'page',
              language: locked.language,
              oldSlug: locked.slug,
              newSlug: dto.slug,
            },
            tx,
          );
        }

        // `LEGACY-015`, пачка `T21`. Видимость страницы меняют **три** входа, а не два:
        // кроме выделенных `publish`/`unpublish` её меняет эта общая форма редактирования.
        // Критерий админского действия называет основанием смену публичной видимости как
        // действие, а не конкретный маршрут, поэтому третий вход пишет те же события
        // (решение арбитра 20.09.2026, `decisions-log.md`).
        //
        // Поле отделено в свою условную запись по образцу `setStatus` ниже: признак
        // изменения даёт результат `updateMany`, а не сравнение в коде между чтением
        // и записью (`L-019`). Идёт она **до** общего `update`, чтобы возвращаемое тело
        // несло уже новый статус — контракт ручки от правки не меняется.
        if (dto.status !== undefined) {
          const changed = await tx.page.updateMany({
            where: { id, status: { not: dto.status } },
            data: { status: dto.status },
          });

          if (changed.count > 0) {
            await this.adminAudit.record(tx, {
              action:
                dto.status === PublicationStatus.published
                  ? AdminAuditAction.PAGE_PUBLISHED
                  : AdminAuditAction.PAGE_UNPUBLISHED,
              targetType: AdminAuditTargetType.PAGE,
              targetId: id,
              actorUserId,
            });
          }
        }

        const updated = await tx.page.update({
          where: { id },
          data: updateInput,
          include: { seo: true },
        });

        // 🔴 `LEGACY-400`: прежнее `Seo`, от которого страница отвязалась (все поля пусты
        // или legacy-`seoId` сменён), удаляется тем же `tx`, если больше никому не нужно.
        if (locked.seoId && updated.seoId !== locked.seoId) {
          await deleteSeoIfUnreferenced(tx, locked.seoId);
        }
        return updated;
      }, PAGE_WRITE_TX_OPTIONS);
    } catch (e) {
      throw pageWriteError(e);
    }
  }

  /**
   * `LEGACY-015`, пачка `T21`. Публикация и снятие страницы с публикации журналируются
   * **обе** (`PAGE_PUBLISHED`/`PAGE_UNPUBLISHED`, решение арбитра 20.09.2026): журнал,
   * знающий одну сторону пары, не молчит, а врёт — это уже проходили на версии книги
   * в `LEGACY-180`.
   *
   * ⚠️ Признак изменения состояния даёт **результат условной записи**, а не пара
   * «прочитали — сравнили — записали» (`L-019`). `updateMany` с `status: { not: status }`
   * в `where` возвращает `count: 0`, если страница уже в целевом состоянии, и тогда
   * события нет: инвариант докблока `AdminAuditEvent` — событие равно изменению
   * состояния, повторная публикация уже опубликованной страницы ничего не меняет.
   * Сравнение в коде между чтением и записью давало бы тот же ответ только в отсутствие
   * встречного запроса, а замка здесь нет.
   *
   * Контракт ручек при этом не меняется: повторный вызов по-прежнему отвечает 200 тем же
   * телом — просто без строки в журнале.
   *
   * `payload` нет: строка жива, её язык и слаг читаются из неё самой. Публичный адрес
   * снятие не освобождает вовсе — слаг остаётся занят `@@unique([language, slug])`,
   * публичная выдача просто фильтрует по `status`.
   */
  async setStatus(
    id: string,
    status: PublicationStatus,
    actorUserId: string,
  ): Promise<PageWithSeo> {
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.page.updateMany({
        where: { id, status: { not: status } },
        data: { status },
      });

      // Ноль изменённых строк — это либо «страницы нет», либо «уже в этом состоянии».
      // Различить их может только чтение: у первого случая ответ 404, у второго 200.
      const page = await tx.page.findUnique({ where: { id }, include: { seo: true } });
      if (!page) throw new NotFoundException('Page not found');

      if (changed.count > 0) {
        await this.adminAudit.record(tx, {
          action:
            status === PublicationStatus.published
              ? AdminAuditAction.PAGE_PUBLISHED
              : AdminAuditAction.PAGE_UNPUBLISHED,
          targetType: AdminAuditTargetType.PAGE,
          targetId: id,
          actorUserId,
        });
      }

      return page;
    }, PAGE_WRITE_TX_OPTIONS);
  }

  /**
   * `LEGACY-395`. У страницы нет ни родителя, ни базового слага отдельно
   * от перевода — сама строка `Page` это и есть один публичный адрес
   * (`language`+`slug`, `getPublicBySlug` выше ищет ровно эту пару и без
   * фоллбэка). Значит вопрос "жив ли адрес ещё" не нужен: `@@unique([language,
   * slug])` не даёт другой живой странице занять ту же пару, пока эта не
   * удалена, а после удаления адрес мёртв безусловно — преемника тоже
   * нет, писать некому (см. тело записи `LEGACY-395`).
   */
  async remove(id: string, actorUserId: string): Promise<{ success: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      // 🔴 `LEGACY-320`: слаг и язык — из строки под замком. Плоское чтение не вставало
      // в очередь за встречным `update`, и уборка редиректов шла по слагу до переименования,
      // а `payload` журнала называл не тот адрес. `FOR UPDATE`, а не `NO KEY`: строка удаляется.
      const [exists] = await tx.$queryRaw<Pick<Page, 'slug' | 'language' | 'seoId'>[]>`
        SELECT slug, language, "seoId" FROM "Page" WHERE id = ${id} FOR UPDATE`;
      if (!exists) throw new NotFoundException('Page not found');

      await tx.page.delete({ where: { id } });

      // 🔴 `LEGACY-400`: `Page.seoId` без каскада — `Seo` удалённой страницы оставалось сиротой.
      await deleteSeoIfUnreferenced(tx, exists.seoId);

      await this.slugRedirects.cleanupDeadRedirects('page', [exists.language], exists.slug, tx);

      // `LEGACY-015`, пачка `T21`. Тем же `tx`, что и удаление: запись, пережившая
      // откат своей операции, — это `LEGACY-036`. Транзакция здесь уже была, новой
      // не заводится.
      //
      // `payload` несёт умерший адрес. Строка `Page` — это и есть один публичный
      // адрес (докблок выше, `LEGACY-395`), преемника у слага нет, и после `delete`
      // ответить, какой адрес перестал существовать, больше нечем. Язык и слаг уже
      // прочитаны ради уборки редиректов и стоят ноль лишних запросов.
      await this.adminAudit.record(tx, {
        action: AdminAuditAction.PAGE_DELETED,
        targetType: AdminAuditTargetType.PAGE,
        targetId: id,
        actorUserId,
        payload: { language: exists.language, slug: exists.slug },
      });

      return { success: true };
    }, PAGE_WRITE_TX_OPTIONS);
  }

  /**
   * Check if a slug exists for a given language.
   * @param slug - The slug to check
   * @param language - The language context
   * @param excludeId - Optional page ID to exclude (when editing)
   * @returns The existing page or null if slug is available
   */
  /**
   * The slug a page currently holds, or null when the id names nothing.
   *
   * Exists so `check-slug` can tell a reserved slug apart from *this page's own*
   * reserved slug. `update()` grandfathers the latter, and without this lookup
   * the check would keep warning the owner about a slug the API accepts.
   */
  async getCurrentSlug(id: string): Promise<string | null> {
    const page = await this.prisma.page.findUnique({ where: { id }, select: { slug: true } });
    return page?.slug ?? null;
  }

  async checkSlugExists(slug: string, language: Language, excludeId?: string) {
    const where: Prisma.PageWhereInput = {
      slug,
      language,
    };

    if (excludeId) {
      where.NOT = { id: excludeId };
    }

    return this.prisma.page.findFirst({
      where,
      select: { id: true, title: true, status: true },
    });
  }

  /**
   * Generate a unique slug by appending a numeric suffix.
   * @param baseSlug - The base slug to make unique
   * @param language - The language context
   * @returns A unique slug with numeric suffix (e.g., "about-us-2")
   */
  async generateUniqueSuggestedSlug(baseSlug: string, language: Language): Promise<string> {
    let suffix = 2;
    let candidateSlug = `${baseSlug}-${suffix}`;

    // Find first available suffix
    while (await this.checkSlugExists(candidateSlug, language)) {
      suffix++;
      candidateSlug = `${baseSlug}-${suffix}`;
    }

    return candidateSlug;
  }

  async findByGroupId(translationGroupId: string) {
    return this.prisma.page.findMany({
      where: { translationGroupId },
      include: { seo: true },
      orderBy: { language: 'asc' },
    });
  }

  /**
   * Legacy-`seoId`: строка обязана существовать и быть **ничьей**. `@unique` у `Page.seoId`
   * не мешает забрать `Seo` перевода категории или версии книги — две сущности делили бы
   * одну строку, и правка SEO одной молча меняла бы другую (`LEGACY-400`).
   */
  private async assertSeoAttachable(tx: Prisma.TransactionClient, seoId: number): Promise<void> {
    const owners = await seoOwnersCount(tx, seoId);
    if (owners === null) throw new BadRequestException(PAGE_SEO_MISSING_MESSAGE);
    if (owners > 0) throw new BadRequestException(PAGE_SEO_TAKEN_MESSAGE);
  }
}

/**
 * Отказы записи страницы, которые означают неверный запрос, — в 400; прочие уходят как есть.
 * Поля берутся из обеих форм отказа (`meta.*` и `meta.driverAdapterError` под `@prisma/adapter-pg`).
 * Под адаптером приходят **имена колонок** базы, у этих трёх они совпадают с полями схемы.
 */
function pageWriteError(e: unknown): unknown {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return e;
  if (e.code === 'P2003') {
    const targets = foreignKeyViolationTargets(e);
    if (targets.includes('Page_seoId_fkey') || targets.includes('seoId')) {
      return new BadRequestException(PAGE_SEO_MISSING_MESSAGE);
    }
  }
  if (e.code === 'P2002') {
    const fields = uniqueViolationFields(e);
    if (fields.includes('slug')) return new BadRequestException(PAGE_SLUG_TAKEN_MESSAGE);
    if (fields.includes('seoId')) {
      return new BadRequestException(PAGE_SEO_TAKEN_MESSAGE);
    }
    // Поля не разобрались вовсе (другая форма отказа) — прежний ответ `create`, 400 про слаг:
    // иного уникального индекса, достижимого из формы, у страницы нет (`systemKey` форма не пишет).
    // Только отказ самой `Page`: `P2002` журнала или истории слагов в той же транзакции — не дубль слага.
    const model = violationModelName(e);
    if (fields.length === 0 && (model === undefined || model === 'Page')) {
      return new BadRequestException(PAGE_SLUG_TAKEN_MESSAGE);
    }
  }
  return e;
}

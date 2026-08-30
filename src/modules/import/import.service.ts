import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { CategoryType, Language, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ImportCategoryDto } from './dto/import-category.dto';
import { ImportTagDto } from './dto/import-tag.dto';
import { SLUG_REGEX } from '../../shared/validators/slug';
import { SlugRedirectService } from '../slug-redirect/slug-redirect.service';
import { CategoryTreeService, MismatchedChildEdge } from '../category/category-tree.service';

const SUPPORTED_LANGS = new Set(Object.values(Language));

/**
 * Клиент транзакции или обычный. Методы записи принимают его параметром, а не
 * ходят в `this.prisma`: оставленный на `this.prisma` вызов внутри
 * `$transaction` уходит на другое соединение и вместе с транзакцией уже не
 * откатывается (`LEGACY-131`).
 */
type PrismaLike = Prisma.TransactionClient | PrismaService;

interface TranslationInput {
  name: string;
  slug: string;
  description?: string | null;
  h1?: string;
  shortDescription?: string | null;
  metaTitle?: string;
  metaDescription?: string | null;
  ogTitle?: string;
  ogDescription?: string | null;
  ogImageUrl?: string | null;
  ogImageAlt?: string;
  canonicalUrl?: string;
  robots?: string;
  indexable?: boolean;
  faq?: Array<{ question: string; answer: string }>;
  relatedTagSlugs?: string[];
  relatedGenreSlugs?: string[];
  relatedCategorySlugs?: string[];
  relatedCollectionSlugs?: string[];
}

export interface ImportResult {
  imported: number;
  updated: number;
  errors: Array<{ key: string; message: string }>;
}

/**
 * Потолок строк для второго прохода `LEGACY-315`. Проход читает детей терминов,
 * сменивших тип в этой партии, — их единицы; потолок стоит потому, что выборка
 * целиком собирается в память, а безлимитный `findMany` на тестовых объёмах
 * неотличим от нормы.
 */
const INCONSISTENT_EDGE_SCAN_LIMIT = 1000;

/**
 * Ключ строки отчёта, которой проход сообщает о собственном усечении. Это не термин,
 * поэтому и ключ не похож на ключ термина: ключи в импорте — слаг-подобные строки.
 */
const INCONSISTENT_EDGE_SCAN_KEY = '(consistency-scan)';

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    private prisma: PrismaService,
    private slugRedirects: SlugRedirectService,
    private readonly categoryTree: CategoryTreeService,
  ) {}

  async importCategories(items: ImportCategoryDto[]): Promise<ImportResult> {
    const result: ImportResult = { imported: 0, updated: 0, errors: [] };

    for (const item of items) {
      const langError = this.validateTranslations(item.translations);
      if (langError) {
        result.errors.push({ key: item.key, message: langError });
      }
    }

    const validItems = items.filter((item) => !result.errors.find((e) => e.key === item.key));

    const allKeys = new Set(validItems.map((i) => i.key));
    for (const item of validItems) {
      if (item.parentKey && !allKeys.has(item.parentKey)) {
        const exists = await this.prisma.category.findUnique({
          where: { key: item.parentKey },
          select: { id: true },
        });
        if (!exists) {
          result.errors.push({
            key: item.key,
            message: `parentKey "${item.parentKey}" not found in database or current batch`,
          });
        }
      }
    }

    const batch = this.orderByParent(
      validItems.filter((item) => !result.errors.find((e) => e.key === item.key)),
      result,
    );

    // 🔴 `LEGACY-315`. Термины, у которых тип действительно сменился и чья
    // транзакция закоммитилась. Край ребра «вниз» проверяется у них в момент
    // записи, но проверка исключает детей, которых эта же партия переводит
    // в тот же новый тип (`becomingKeys` ниже). Исключение верно ровно пока
    // партия проходит целиком, а партия не атомарна: транзакция на термин.
    // Поэтому в конце партии делается второй проход — `reportInconsistentEdges`.
    const retyped = new Map<string, ImportCategoryDto['type']>();

    for (const item of batch) {
      try {
        // 🔴 `LEGACY-303` + `LEGACY-308`. Край ребра «вниз» сверяется с конечным
        // состоянием партии, а не только с базой: ребёнок, которого этот же файл
        // переводит в тот же новый тип, разнотипным ребром не станет. Без этого
        // перетипизация поддерева одним файлом невозможна ни в каком порядке —
        // родитель отвергается по ребёнку, ребёнок по родителю, чья запись
        // только что откатилась. Решение арбитра от 29.08.2026.
        //
        // Список строится по `batch` — то есть уже после `orderByParent`
        // и без элементов, отбракованных ранее.
        const becomingKeys = batch
          .filter((other) => other.type === item.type && other.key !== item.key)
          .map((other) => other.key);

        // 🔴 `LEGACY-312`. Счётчик считается по тому, что действительно сделала
        // транзакция, а не по отдельному чтению на пуле: то чтение устаревало
        // ровно так же, как и развилка, которую оно раньше выбирало, и на двух
        // одновременных импортах одного ключа отчёт расходился с базой.
        const { created, retypedId } = await this.upsertCategory(item, becomingKeys);
        if (created) {
          result.imported++;
        } else {
          result.updated++;
        }
        if (retypedId) {
          // Ключ термина сюда не кладётся: он есть в базе, и брать его отсюда
          // значило бы назвать родителя по строке файла (см. `findMismatchedChildren`).
          retyped.set(retypedId, item.type);
        }
      } catch (err: unknown) {
        const prismaErr = err as Prisma.PrismaClientKnownRequestError;
        if (prismaErr.code === 'P2002') {
          result.errors.push({
            key: item.key,
            message: `Duplicate key "${item.key}" or slug conflict`,
          });
        } else {
          result.errors.push({ key: item.key, message: getErrorMessage(err) });
        }
      }
    }

    await this.reportInconsistentEdges(retyped, result);

    return result;
  }

  async importTags(items: ImportTagDto[]): Promise<ImportResult> {
    const result: ImportResult = { imported: 0, updated: 0, errors: [] };

    for (const item of items) {
      const langError = this.validateTranslations(item.translations);
      if (langError) {
        result.errors.push({ key: item.key, message: langError });
        continue;
      }

      try {
        // 🔴 `LEGACY-313`. Счётчик считается по тому, что действительно сделала
        // транзакция, а не по отдельному чтению на пуле: то чтение устаревало
        // ровно так же, как и развилка, которую оно раньше дублировало.
        const { created } = await this.upsertTag(item);
        if (created) {
          result.imported++;
        } else {
          result.updated++;
        }
      } catch (err: unknown) {
        const prismaErr = err as Prisma.PrismaClientKnownRequestError;
        if (prismaErr.code === 'P2002') {
          result.errors.push({
            key: item.key,
            message: `Duplicate key "${item.key}" or slug conflict`,
          });
        } else {
          result.errors.push({ key: item.key, message: getErrorMessage(err) });
        }
      }
    }

    return result;
  }

  /**
   * Переставить партию так, чтобы родитель шёл раньше ребёнка (`LEGACY-258`).
   *
   * Проверка выше разрешает ссылаться на родителя, которого в базе ещё нет, если
   * он есть в этой же партии, — но порядка внутри партии не требует. Элементы
   * обрабатывались в порядке массива, и файл, где ребёнок записан выше родителя,
   * импортировался «успешно» с термином, оставшимся в корне дерева.
   *
   * Обход Кана: элементы без родителя в партии идут первыми, каждый следующий
   * открывает своих детей. Кто остался — участник цикла (`a → b → a`), и для него
   * порядка не существует вовсе: такой элемент уходит в `errors` и до записи не
   * доходит. Ссылка на родителя вне партии ребром не считается: он либо уже в
   * базе, либо проверка выше уже записала отказ.
   */
  private orderByParent(items: ImportCategoryDto[], result: ImportResult): ImportCategoryDto[] {
    // Повторённый ключ ломает счётчик Кана (`pending` уходит в минус), и элемент
    // молча выпадал из партии: ни в `imported`, ни в `errors`. Отбор идёт по
    // порядку вхождения, а не по тождеству объекта: один и тот же элемент может
    // стоять в файле дважды, и тогда сравнение ссылок обе копии считает первой.
    const byKey = new Map<string, ImportCategoryDto>();
    const unique: ImportCategoryDto[] = [];
    for (const item of items) {
      if (byKey.has(item.key)) {
        result.errors.push({
          key: item.key,
          message: `duplicate key "${item.key}" inside the batch`,
        });
        continue;
      }
      byKey.set(item.key, item);
      unique.push(item);
    }
    items = unique;
    const children = new Map<string, ImportCategoryDto[]>();
    const pending = new Map<string, number>();
    const ordered: ImportCategoryDto[] = [];
    const queue: ImportCategoryDto[] = [];

    for (const item of items) {
      const parentInBatch = item.parentKey && byKey.has(item.parentKey) ? item.parentKey : null;
      pending.set(item.key, parentInBatch ? 1 : 0);
      if (parentInBatch) {
        const siblings = children.get(parentInBatch) ?? [];
        siblings.push(item);
        children.set(parentInBatch, siblings);
      } else {
        queue.push(item);
      }
    }

    while (queue.length > 0) {
      const item = queue.shift() as ImportCategoryDto;
      ordered.push(item);
      for (const child of children.get(item.key) ?? []) {
        const left = (pending.get(child.key) ?? 0) - 1;
        pending.set(child.key, left);
        if (left === 0) queue.push(child);
      }
    }

    if (ordered.length < items.length) {
      const orderedKeys = new Set(ordered.map((item) => item.key));
      const stuck = items.filter((item) => !orderedKeys.has(item.key));
      const stuckKeys = new Set(stuck.map((item) => item.key));

      // Участник цикла — тот, до кого от него самого есть путь по `parentKey`.
      // Остальные застряли не своей виной: их предок в цикле, и говорить им про
      // цикл в их собственной ссылке — значит посылать чинить не то место.
      const inCycle = (item: ImportCategoryDto): boolean => {
        const seen = new Set<string>();
        let current: ImportCategoryDto | undefined = item;
        while (current?.parentKey && stuckKeys.has(current.parentKey)) {
          if (current.parentKey === item.key) return true;
          if (seen.has(current.parentKey)) return false;
          seen.add(current.parentKey);
          current = byKey.get(current.parentKey);
        }
        return false;
      };

      for (const item of stuck) {
        result.errors.push({
          key: item.key,
          message: inCycle(item)
            ? `parentKey "${item.parentKey ?? ''}" forms a cycle inside the batch`
            : `parentKey "${item.parentKey ?? ''}" is part of a cycle and cannot be imported`,
        });
      }
    }

    return ordered;
  }

  private validateTranslations(translations: Record<string, TranslationInput>): string | null {
    const langs = Object.keys(translations);
    if (langs.length === 0) return 'At least one translation required';
    for (const lang of langs) {
      if (!SUPPORTED_LANGS.has(lang as Language)) {
        return `Unsupported language "${lang}". Supported: ${Object.values(Language).join(', ')}`;
      }
      const tr = translations[lang] as TranslationInput | undefined;
      if (!tr || typeof tr !== 'object') {
        return `Translation for "${lang}" must be an object`;
      }
      if (!tr.name || typeof tr.name !== 'string' || tr.name.length < 2) {
        return `Translation "${lang}" name: min 2 chars`;
      }
      if (!tr.slug || !SLUG_REGEX.test(tr.slug)) {
        return `Translation "${lang}" slug: invalid kebab-case format`;
      }
    }
    return null;
  }

  /**
   * 🔴 `LEGACY-315`. Второй проход в конце партии: сверка края ребра «вниз»
   * с базой, а не с содержимым файла.
   *
   * Проверка при записи исключает детей, которых эта же партия переводит в тот же
   * новый тип (`becomingKeys`, решение арбитра по `LEGACY-303`/`LEGACY-308`).
   * Исключение верно ровно настолько, насколько партия атомарна, а она не атомарна:
   * каждый термин пишется своей транзакцией. Родитель коммитит смену типа, ребёнок
   * следом падает по своей причине — и в базе остаётся разнотипное ребро, которое
   * ни один путь записи больше не заведёт, но и не починит. Отчёт при этом честен
   * про упавшего ребёнка и молчит про испорченное дерево.
   *
   * ⚠️ Проход **только читает** и запускается только при непустых `errors`
   * и только по терминам, чей тип действительно сменился. Иначе давно испорченное
   * ребро (`LEGACY-263`) краснило бы успешную партию, которая его не трогала.
   *
   * Решение арбитра от 29.08.2026, строка в `decisions-log.md`.
   */
  private async reportInconsistentEdges(
    retyped: Map<string, ImportCategoryDto['type']>,
    result: ImportResult,
  ): Promise<void> {
    // Партия прошла целиком — исключение по её составу оказалось верным,
    // и спрашивать базу не о чем.
    if (result.errors.length === 0 || retyped.size === 0) {
      return;
    }

    // ⚠️ Проход диагностический: он ничего не чинит и не пишет. Его собственный
    // отказ не должен превращать частично прошедшую партию в 500 без тела —
    // иначе оператор не узнает даже того, что уже записано, и погонит файл заново.
    let scan: { edges: MismatchedChildEdge[]; truncated: boolean };
    try {
      scan = await this.categoryTree.findMismatchedChildren(
        [...retyped.entries()].map(([id, expectedType]) => ({ id, expectedType })),
        INCONSISTENT_EDGE_SCAN_LIMIT,
      );
    } catch (error) {
      // 🔴 `L-015`. Отказ проверки — это «я не проверила», а не «всё хорошо».
      // Молчащий отчёт здесь байт в байт совпал бы с отчётом по целому дереву,
      // и оператор, починив названный слаг, не узнал бы, что файл надо перегнать.
      // Строка в `errors` при этом не делает из ответа 500: ручка по-прежнему
      // отдаёт отчёт, просто честный.
      this.logger.warn(
        `Import consistency scan failed after a partial batch; the report may be missing ` +
          `inconsistent edges. ${getErrorMessage(error)}`,
      );
      result.errors.push({
        key: INCONSISTENT_EDGE_SCAN_KEY,
        message:
          `Consistency scan could not run, so inconsistent edges left by the failed terms ` +
          `are not listed. Fix the reported errors and import the file again.`,
      });
      return;
    }

    // Что считать несовпадением, решает `CategoryTreeService`: здесь только текст
    // строки отчёта. Тип родителя в ребре — из базы, а не из файла.
    for (const edge of scan.edges) {
      result.errors.push({
        key: edge.parent.key,
        message:
          `Tree left inconsistent: child "${edge.key}" of type "${edge.type}" stayed under ` +
          `"${edge.parent.key}", which is now "${edge.parent.type}". ` +
          `The child was expected to change type in the same file but its own record failed. ` +
          `Fix the reported errors and import the file again.`,
      });
    }

    // 🔴 `L-015`. Проверка обязана уметь сказать «я проверила не всё». Упёрлись
    // в потолок — значит рёбер может быть больше, и молчание отчёта здесь читалось
    // бы как «остальное в порядке».
    if (scan.truncated) {
      result.errors.push({
        key: INCONSISTENT_EDGE_SCAN_KEY,
        message:
          `Consistency scan stopped at ${INCONSISTENT_EDGE_SCAN_LIMIT} rows: there may be more ` +
          `inconsistent edges than listed above. Fix the reported errors and import the file again.`,
      });
    }
  }

  /**
   * Завести или обновить термин таксономии.
   *
   * 🔴 `LEGACY-312`. Развилка «создание или обновление» принимается **внутри**
   * транзакции, после блокировки. До 29.08.2026 она бралась из чтения на пуле:
   * два одновременных импорта одного ключа оба читали «термина нет», оба уходили
   * в ветку создания, и вторая запись падала `P2002` по `key` — в отчёте
   * появлялась ошибка импорта там, где термин существовал и его надо было
   * обновить.
   *
   * 🔴 `LEGACY-304`. Из той же устаревшей строки брались дефолты `indexable`,
   * `isVisible`, `sortOrder` и список переводов, по которому ветка обновления
   * решает, создавать перевод или обновлять. Соседний запрос, сменивший
   * `sortOrder` между чтением и транзакцией, затирался молча, а отчёт показывал
   * `updated`, а не конфликт. Правка `LEGACY-274` сделала это в
   * `CategoryService.update` и не тронула импорт — разошедшиеся половины одного
   * правила расходятся дальше сами.
   *
   * Возвращает признак того, что термин был создан: счётчики отчёта считаются
   * по нему, а не по второму чтению на пуле, которое устаревало ровно так же.
   */
  private async upsertCategory(
    dto: ImportCategoryDto,
    becomingKeys: string[] = [],
  ): Promise<{ created: boolean; retypedId: string | null }> {
    const commonData: Prisma.CategoryCreateInput = {
      type: dto.type,
      name: this.getFirstName(dto.translations),
      slug: this.getFirstSlug(dto.translations),
      key: dto.key,
      indexable: dto.indexable ?? true,
      isVisible: dto.isVisible ?? true,
      sortOrder: dto.sortOrder ?? 0,
    };

    // Обе ветки — одна запись целиком (`LEGACY-131`, `LEGACY-257`), и обе
    // начинаются с блокировки дерева первым оператором (`LEGACY-274`). Порядок
    // держит `runInLockedTree`, а не комментарий у места вызова (`LEGACY-310`).
    return this.categoryTree.runInLockedTree(async (tx) => {
      const existing = await tx.category.findUnique({
        where: { key: dto.key },
        include: { translations: true },
      });

      if (!existing) {
        // Термин и его переводы — одна запись (`LEGACY-131`). Обрыв между ними
        // оставляет категорию, которая занимает `slug` и `key` и попадает в дерево,
        // но не показывается ни на одной языковой версии сайта: публичные маршруты
        // отбирают по `CategoryTranslation` нужного языка.
        const created = await tx.category.create({ data: commonData });

        if (dto.parentKey) {
          await this.updateParentId(tx, { id: created.id, type: dto.type }, dto.key, dto.parentKey);
        }

        for (const [langCode, tr] of Object.entries(dto.translations)) {
          await this.createCategoryTranslation(tx, created.id, langCode as Language, tr);
        }
        // Только что заведённый термин детей иметь не может, поэтому проверять
        // у него край ребра «вниз» второму проходу (`LEGACY-315`) не за чем.
        return { created: true, retypedId: null };
      }

      // 🔴 `LEGACY-308`. Тип пишется безусловно, а проверка родителя стояла под
      // `if (dto.parentKey !== undefined)` — то есть зависела от наличия поля
      // в файле импорта, а не от того, меняется ли что-то из пары «родитель,
      // тип». Термин без `parentKey` в JSON, но со сменённым `type`, записывал
      // тип и оставался ребром под родителем чужого типа: тот же дефект, что
      // `LEGACY-275` закрыла в `CategoryService.update`, на втором пути записи.
      //
      // Блокировка на этом пути была и раньше, но она сериализует запись,
      // а проверки, которую она стережёт, здесь не существовало: очередь
      // к той же порче, а не защита от неё.
      const typeChanging = existing.type !== dto.type;

      await tx.category.update({
        where: { key: dto.key },
        data: {
          type: dto.type,
          name: this.getFirstName(dto.translations),
          // 🔴 `slug` намеренно НЕ переписывается при повторном импорте.
          //
          // Базовый слаг берётся из `getFirstSlug` — то есть из ПЕРВОГО перевода по
          // порядку ключей JSON. Значит тот же набор данных с переставленными языками
          // переименовывал категорию сам по себе, а с историей слагов (LEGACY-062)
          // это порождало бы ещё и 308 на переименования, которых никто не делал.
          // Публичный адрес не может зависеть от форматирования файла импорта.
          // При создании (ветка выше) слаг по-прежнему выводится оттуда же — там
          // выбирать не из чего, и прежнего адреса не существует.
          //
          // Дефолты берутся из строки, перечитанной внутри транзакции
          // (`LEGACY-304`), а не из чтения на пуле.
          indexable: dto.indexable ?? existing.indexable,
          isVisible: dto.isVisible ?? existing.isVisible,
          sortOrder: dto.sortOrder ?? existing.sortOrder,
        },
      });

      if (dto.parentKey !== undefined) {
        // `|| null`, а не `?? null`: пустая строка — это «родителя нет», как и
        // в ветке создания (`if (dto.parentKey)`). С `??` она доезжала до
        // поиска родителя по ключу `""` и после `LEGACY-258` валила весь
        // термин — один и тот же файл проходил при первом импорте и падал при
        // повторном.
        await this.updateParentId(
          tx,
          { id: existing.id, type: dto.type },
          dto.key,
          dto.parentKey || null,
        );
      } else if (typeChanging && existing.parentId) {
        // Родитель в файле не назван, но тип меняется: проверять надо
        // фактического родителя из базы, а не пропускать проверку вовсе.
        await this.assertExistingParentAllowed(
          tx,
          { id: existing.id, type: dto.type },
          existing.parentId,
        );
      }

      // 🔴 `LEGACY-303`, второй край того же ребра: у термина, сменившего тип,
      // остаются дети прежнего типа. Условие и текст отказа — те же, что
      // на админском пути: правило живёт в `CategoryTreeService` в одном месте.
      if (typeChanging) {
        await this.categoryTree.assertChildTypesAllowed(
          { id: existing.id, type: dto.type },
          tx,
          becomingKeys,
        );
      }

      for (const [langCode, tr] of Object.entries(dto.translations)) {
        const language = langCode as Language;
        const existingTr = existing.translations.find((t) => t.language === language);
        if (existingTr) {
          // Импорт — такой же путь смены слага, как форма в админке, и до 09.08.2026
          // он шёл в обход истории: класс считался закрытым для категорий и тегов,
          // хотя закрыт был только через сервисы (LEGACY-062). Запись в историю
          // идёт тем же `tx`, что и сама смена, — иначе редирект переживёт откат.
          if (tr.slug && existingTr.slug !== tr.slug) {
            await this.slugRedirects.record(
              { entityType: 'category', language, oldSlug: existingTr.slug, newSlug: tr.slug },
              tx,
            );
          }
          await tx.categoryTranslation.update({
            where: { categoryId_language: { categoryId: existing.id, language } },
            data: {
              name: tr.name,
              slug: tr.slug,
              ...this.buildCategoryTranslationData(tr),
            },
          });
        } else {
          await this.createCategoryTranslation(tx, existing.id, language, tr);
        }
      }

      // 🔴 `LEGACY-315`. Идентификатор возвращается только у термина, который
      // действительно сменил тип: по нему второй проход в конце партии сверяет
      // край ребра «вниз» с базой. Термин, тип которого не менялся, разнотипного
      // ребра не порождает, и включать его в проход значило бы краснить успешную
      // партию на давно испорченном дереве (`LEGACY-263`).
      return { created: false, retypedId: typeChanging ? existing.id : null };
    });
  }

  /**
   * Допустим ли фактический родитель термина после смены его типа.
   *
   * Отдельно от `updateParentId` потому, что писать здесь нечего: ребро уже
   * стоит, меняется только тип ребёнка. Условие берётся из `CategoryTreeService`
   * — того же, что стережёт админский путь (`LEGACY-264`, `LEGACY-005`).
   */
  private async assertExistingParentAllowed(
    tx: Prisma.TransactionClient,
    child: { id: string; type: CategoryType },
    parentId: string,
  ): Promise<void> {
    const parent = await tx.category.findUnique({
      where: { id: parentId },
      select: { id: true, type: true },
    });
    if (!parent) {
      throw new BadRequestException(`parent category "${parentId}" not found`);
    }
    await this.categoryTree.assertParentAllowed(child, parent, tx);
  }

  private async createCategoryTranslation(
    db: PrismaLike,
    categoryId: string,
    language: Language,
    tr: TranslationInput,
  ) {
    const data = this.buildCategoryTranslationData(tr);
    return db.categoryTranslation.create({
      data: {
        categoryId,
        language,
        name: tr.name,
        slug: tr.slug,
        // Imported terms arrive empty too — see CategoryService.createTranslation.
        bookCount: 0,
        autoIndexable: false,
        ...data,
      },
    });
  }

  private buildCategoryTranslationData(tr: TranslationInput): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const field of [
      'description',
      'h1',
      'shortDescription',
      'metaTitle',
      'metaDescription',
      'ogTitle',
      'ogDescription',
      'ogImageUrl',
      'ogImageAlt',
    ] as const) {
      if (tr[field] !== undefined) {
        result[field] = tr[field] ?? null;
      }
    }
    if (tr.faq !== undefined) {
      result.faq = tr.faq ?? null;
    }
    return result;
  }

  /**
   * Завести или обновить тег.
   *
   * 🔴 `LEGACY-313`. Развилка «создание или обновление» принимается **внутри**
   * транзакции, а не по чтению на пуле, — так же, как это сделано для категорий
   * (`LEGACY-312`). Оттуда же берутся дефолты `indexable`, `isVisible`, `sortOrder`
   * и список переводов, по которому ветка обновления решает, создавать перевод
   * или обновлять.
   *
   * ⚠️ **Что перенос даёт и чего не даёт.** Он убирает расхождение клиентов:
   * решение и запись делает один и тот же клиент. Но сам по себе перенос
   * не закрывает ни одной гонки — окно он только сужает, и писать иначе нельзя
   * (урок `L-019`). Закрывают их другие вещи, и вот какие:
   *
   * 1. Два одновременных импорта одного ключа закрывает **уникальный индекс
   *    на `Tag.key`**, а не этот перенос: проигравший `create` получает `P2002`
   *    и строку `Duplicate key` в `errors`. Дерева у тега нет, поэтому
   *    рекомендательной блокировки, как у категорий (`LEGACY-274`), здесь нет
   *    и не нужно — единственный инвариант держит база. Решение арбитра
   *    от 29.08.2026, строка в `decisions-log.md`.
   * 2. `LEGACY-318`. Потерянное обновление `indexable`, `isVisible`, `sortOrder`
   *    устранено: значения столбцов больше не читаются и не переписываются,
   *    в `data` попадает только то, что названо в файле импорта. Строка при этом
   *    по-прежнему не заперта, и закрыто здесь не запиранием, а снятием чтения —
   *    устаревать стало нечему.
   *
   *    Гонка по `existing.slug` (запись редиректа базового слага ниже),
   *    по `existing.translations` (развилка «создать или обновить перевод»)
   *    и `P2025` при удалении строки в окне остаются открытыми — `LEGACY-320`.
   *
   * Возвращает признак того, что тег был создан: счётчики отчёта считаются
   * по нему, а не по второму чтению на пуле, которое устаревало ровно так же.
   */
  private async upsertTag(dto: ImportTagDto): Promise<{ created: boolean }> {
    // Одна транзакция на весь термин (`LEGACY-257`) и на обе ветки развилки
    // (`LEGACY-313`): базовая строка, история слагов и все переводы.
    //
    // `runInTree`, а не свой `$transaction`: это тот же метод, которым ходит
    // категория, но без блокировки дерева — ровно случай, ради которого он
    // заведён. Границы транзакции задаются там одним местом на оба пути.
    return this.categoryTree.runInTree(async (tx) => {
      const existing = await tx.tag.findUnique({
        where: { key: dto.key },
        include: { translations: true },
      });

      if (!existing) {
        // Тот же рисунок, что у категорий, и та же причина (`LEGACY-131`): тег
        // без переводов занимает `slug` и `key`, но публичным маршрутам не виден.
        const created = await tx.tag.create({
          data: {
            name: dto.name,
            slug: dto.slug,
            key: dto.key,
            indexable: dto.indexable ?? true,
            isVisible: dto.isVisible ?? true,
            sortOrder: dto.sortOrder ?? 0,
          },
        });

        for (const [langCode, tr] of Object.entries(dto.translations)) {
          await this.createTagTranslation(tx, created.id, langCode as Language, tr);
        }
        return { created: true };
      }

      // Базовый слаг тега приходит явным полем `dto.slug`, а не выводится из
      // порядка переводов, — поэтому здесь его смена настоящая, и её можно записывать.
      if (dto.slug && existing.slug !== dto.slug) {
        await this.slugRedirects.recordBaseSlugChange('tag', existing.slug, dto.slug, tx);
      }
      await tx.tag.update({
        where: { key: dto.key },
        data: {
          name: dto.name,
          slug: dto.slug,
          // 🔴 `LEGACY-318`. Поле, которого нет в файле импорта, не попадает
          // в `data` вовсе — прежде сюда подставлялось значение столбца,
          // прочитанное выше в этой же транзакции. Разница видна только под
          // гонкой: админский `PATCH /tags/:id {"isVisible": false}`,
          // закоммитившийся между чтением и этой записью, затирался значением
          // из снимка, и тег молча возвращался на витрину при `updated: 1`
          // и пустых `errors`.
          //
          // Вне гонки результат тот же: «оставить как было» и «не трогать»
          // дают одно значение, потому что «как было» и лежит в столбце.
          // Решение арбитра от 30.08.2026.
          //
          // ⚠️ Сравнение нестрогое (`!= null`), и это не небрежность.
          // `@IsOptional()` в `ImportTagDto` пропускает и `undefined`, и `null`,
          // а `ValidationPipe` объявленное поле со значением `null` не вырезает —
          // значит `{"isVisible": null}` в файле импорта доедет сюда как `null`.
          // Все три столбца `NOT NULL`, поэтому строгое `!== undefined` отправило
          // бы `null` в Prisma и уронило бы всю транзакцию термина: ни базовая
          // строка, ни переводы, ни редирект слага не записались бы. Прежний
          // `dto.X ?? existing.X` такой файл принимал, и терять это нельзя.
          ...(dto.indexable != null ? { indexable: dto.indexable } : {}),
          ...(dto.isVisible != null ? { isVisible: dto.isVisible } : {}),
          ...(dto.sortOrder != null ? { sortOrder: dto.sortOrder } : {}),
        },
      });

      for (const [langCode, tr] of Object.entries(dto.translations)) {
        const language = langCode as Language;
        const existingTr = existing.translations.find((t) => t.language === language);
        if (existingTr) {
          if (tr.slug && existingTr.slug !== tr.slug) {
            await this.slugRedirects.record(
              { entityType: 'tag', language, oldSlug: existingTr.slug, newSlug: tr.slug },
              tx,
            );
          }
          await tx.tagTranslation.update({
            where: { tagId_language: { tagId: existing.id, language } },
            data: {
              name: tr.name,
              slug: tr.slug,
              ...this.buildTagTranslationData(tr),
            },
          });
        } else {
          await this.createTagTranslation(tx, existing.id, language, tr);
        }
      }

      return { created: false };
    });
  }

  private async createTagTranslation(
    db: PrismaLike,
    tagId: string,
    language: Language,
    tr: TranslationInput,
  ) {
    const data = this.buildTagTranslationData(tr);
    return db.tagTranslation.create({
      data: {
        tagId,
        language,
        name: tr.name,
        slug: tr.slug,
        // Imported terms arrive empty too — see CategoryService.createTranslation.
        bookCount: 0,
        autoIndexable: false,
        ...data,
      },
    });
  }

  private buildTagTranslationData(tr: TranslationInput): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const scalarFields = [
      'description',
      'h1',
      'shortDescription',
      'metaTitle',
      'metaDescription',
      'ogTitle',
      'ogDescription',
      'ogImageUrl',
      'ogImageAlt',
      'canonicalUrl',
      'robots',
    ] as const;
    for (const field of scalarFields) {
      if (tr[field] !== undefined) {
        result[field] = tr[field] ?? null;
      }
    }
    if (tr.indexable !== undefined) {
      result.indexable = tr.indexable;
    }
    if (tr.faq !== undefined) {
      result.faq = tr.faq ?? null;
    }
    for (const field of [
      'relatedTagSlugs',
      'relatedGenreSlugs',
      'relatedCategorySlugs',
      'relatedCollectionSlugs',
    ] as const) {
      if (tr[field] !== undefined) {
        result[field] = tr[field] ?? null;
      }
    }
    return result;
  }

  /**
   * Привязать категорию к родителю (`LEGACY-258`).
   *
   * Раньше здесь стоял `if (parent)` без `else`: не нашли родителя — молча ничего
   * не сделали, а элемент всё равно уходил в `imported`. Оператор видел успешный
   * импорт, а термин оставался в корне дерева. Теперь отсутствие родителя — отказ:
   * он валит транзакцию термина и попадает в `errors` по его ключу. Порядок внутри
   * партии за это отвечать не должен — его выправляет `orderByParent`.
   */
  private async updateParentId(
    db: PrismaLike,
    child: { id: string; type: CategoryType },
    key: string,
    parentKey: string | null,
  ) {
    if (parentKey === null) {
      await db.category.update({
        where: { key },
        data: { parentId: null },
      });
      return;
    }

    const parent = await db.category.findUnique({
      where: { key: parentKey },
      select: { id: true, type: true },
    });

    if (!parent) {
      throw new BadRequestException(`parentKey "${parentKey}" not found`);
    }

    // 🔴 Родителя мало найти: `orderByParent` видит только рёбра **внутри партии**,
    // а родитель из базы может оказаться потомком импортируемого термина. Такая
    // запись замыкает дерево, и после неё подъём по предкам не завершается
    // никогда (`LEGACY-263`). Типы родителя и ребёнка тоже обязаны совпадать:
    // иначе термин не виден правильно ни в одном дереве — `getTree(type)`
    // отбирает по типу (`LEGACY-264`).
    //
    // Условия не переписаны здесь заново, а взяты из `CategoryTreeService` —
    // того же, что стережёт админский путь. Клиент передаётся **тот же**
    // (`db`): проверка на `this.prisma` не увидела бы строк этой транзакции.
    // Сам термин приходит параметром: вызывающий только что его создал или
    // обновил, и перечитывать строку внутри транзакции незачем — подъём по
    // предкам и так стоит до `CATEGORY_TREE_MAX_DEPTH` запросов в её бюджете.
    await this.categoryTree.assertParentAllowed(child, parent, db);

    await db.category.update({
      where: { key },
      data: { parentId: parent.id },
    });
  }

  private getFirstName(translations: Record<string, TranslationInput>): string {
    const first = Object.values(translations)[0];
    return first?.name ?? '';
  }

  private getFirstSlug(translations: Record<string, TranslationInput>): string {
    const first = Object.values(translations)[0];
    return first?.slug ?? '';
  }
}

import { BadRequestException, Injectable } from '@nestjs/common';
import { Language, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ImportCategoryDto } from './dto/import-category.dto';
import { ImportTagDto } from './dto/import-tag.dto';
import { SLUG_REGEX } from '../../shared/validators/slug';
import { SlugRedirectService } from '../slug-redirect/slug-redirect.service';

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

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

@Injectable()
export class ImportService {
  constructor(
    private prisma: PrismaService,
    private slugRedirects: SlugRedirectService,
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

    for (const item of batch) {
      try {
        const wasExisting = await this.prisma.category.findUnique({
          where: { key: item.key },
          select: { id: true },
        });
        await this.upsertCategory(item);
        if (wasExisting) {
          result.updated++;
        } else {
          result.imported++;
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

  async importTags(items: ImportTagDto[]): Promise<ImportResult> {
    const result: ImportResult = { imported: 0, updated: 0, errors: [] };

    for (const item of items) {
      const langError = this.validateTranslations(item.translations);
      if (langError) {
        result.errors.push({ key: item.key, message: langError });
        continue;
      }

      try {
        const wasExisting = await this.prisma.tag.findUnique({
          where: { key: item.key },
          select: { id: true },
        });
        await this.upsertTag(item);
        if (wasExisting) {
          result.updated++;
        } else {
          result.imported++;
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
   * Границы интерактивной транзакции импорта.
   *
   * Дефолт Prisma — `timeout: 5000`, `maxWait: 2000`. После `LEGACY-257` термин
   * пишется одной транзакцией целиком, и у тега со сменившимся базовым слагом и
   * пятью переводами в ней набирается под четыре десятка операторов: запись
   * истории слагов — три запроса на язык. Пяти секунд такой цепочке не хватает,
   * а `P2028` откатывает термин целиком. Числа те же, что у `PersonsService`
   * и `ContributorsService`, где цепочка такой же длины.
   *
   * ⚠️ Транзакция удерживает соединение всё это время, а пул у приложения один
   * (`LEGACY-256`). Удлинять эти числа без нужды нельзя.
   */
  private static readonly TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 };

  private async upsertCategory(dto: ImportCategoryDto) {
    const existing = await this.prisma.category.findUnique({
      where: { key: dto.key },
      include: { translations: true },
    });

    const commonData: Prisma.CategoryCreateInput = {
      type: dto.type,
      name: this.getFirstName(dto.translations),
      slug: this.getFirstSlug(dto.translations),
      key: dto.key,
      indexable: dto.indexable ?? true,
      isVisible: dto.isVisible ?? true,
      sortOrder: dto.sortOrder ?? 0,
    };

    if (existing) {
      // Обновление термина — тоже одна запись (`LEGACY-257`). До 19.08.2026 здесь
      // шли независимые `await`, а каждый существующий перевод обновлялся своей
      // транзакцией: отказ на третьем языке из пяти оставлял термин с частью
      // новых переводов и уже переписанной базовой строкой, а счётчик `updated`
      // при этом не увеличивался — отчёт расходился с базой молча.
      await this.prisma.$transaction(async (tx) => {
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
            // При создании (ветка ниже) слаг по-прежнему выводится оттуда же — там
            // выбирать не из чего, и прежнего адреса не существует.
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
          await this.updateParentId(tx, dto.key, dto.parentKey || null);
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
      }, ImportService.TX_OPTIONS);
    } else {
      // Термин и его переводы — одна запись (`LEGACY-131`). Обрыв между ними
      // оставляет категорию, которая занимает `slug` и `key` и попадает в дерево,
      // но не показывается ни на одной языковой версии сайта: публичные маршруты
      // отбирают по `CategoryTranslation` нужного языка.
      await this.prisma.$transaction(async (tx) => {
        const created = await tx.category.create({
          data: commonData,
        });

        if (dto.parentKey) {
          await this.updateParentId(tx, dto.key, dto.parentKey);
        }

        for (const [langCode, tr] of Object.entries(dto.translations)) {
          await this.createCategoryTranslation(tx, created.id, langCode as Language, tr);
        }
      }, ImportService.TX_OPTIONS);
    }
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

  private async upsertTag(dto: ImportTagDto) {
    const existing = await this.prisma.tag.findUnique({
      where: { key: dto.key },
      include: { translations: true },
    });

    if (existing) {
      // Одна транзакция на весь термин (`LEGACY-257`): базовая строка, история
      // слагов и все переводы. Раньше их было столько, сколько существующих
      // переводов, плюс запись новых вообще без транзакции.
      await this.prisma.$transaction(async (tx) => {
        // Базовый слаг тега приходит явным полем `dto.slug`, а не выводится из порядка
        // переводов, — поэтому здесь его смена настоящая, и её можно записывать.
        if (dto.slug && existing.slug !== dto.slug) {
          await this.slugRedirects.recordBaseSlugChange('tag', existing.slug, dto.slug, tx);
        }
        await tx.tag.update({
          where: { key: dto.key },
          data: {
            name: dto.name,
            slug: dto.slug,
            indexable: dto.indexable ?? existing.indexable,
            isVisible: dto.isVisible ?? existing.isVisible,
            sortOrder: dto.sortOrder ?? existing.sortOrder,
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
      }, ImportService.TX_OPTIONS);
    } else {
      // Тот же рисунок, что у категорий, и та же причина (`LEGACY-131`): тег без
      // переводов занимает `slug` и `key`, но публичным маршрутам не виден.
      await this.prisma.$transaction(async (tx) => {
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
      }, ImportService.TX_OPTIONS);
    }
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
  private async updateParentId(db: PrismaLike, key: string, parentKey: string | null) {
    if (parentKey === null) {
      await db.category.update({
        where: { key },
        data: { parentId: null },
      });
      return;
    }

    const parent = await db.category.findUnique({
      where: { key: parentKey },
      select: { id: true },
    });

    if (!parent) {
      throw new BadRequestException(`parentKey "${parentKey}" not found`);
    }

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

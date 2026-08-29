import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import {
  PUBLIC_BOOK_SELECT,
  PUBLIC_BOOK_VERSION_SELECT,
} from '../../common/selects/public-book.select';
import { PrismaService } from '../../prisma/prisma.service';
import { TaxonomyIndexabilityService } from '../seo/indexability/taxonomy-indexability.service';
import { SlugRedirectService } from '../slug-redirect/slug-redirect.service';
import { CategoryTreeService, type PrismaLike } from './category-tree.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { Prisma, Category as PrismaCategory, Language } from '@prisma/client';
import { resolveRequestedLanguage } from '../../shared/language/language.util';
import { CreateCategoryTranslationDto } from './dto/create-category-translation.dto';
import { UpdateCategoryTranslationDto } from './dto/update-category-translation.dto';

export type CategoryTreeNode = {
  id: string;
  name: string;
  slug: string;
  key: string;
  type: PrismaCategory['type'];
  parentId: string | null;
  booksCount: number;
  /**
   * CategoryTranslation.bookCount (cached, per-language) for the requested `lang`.
   * Undefined when `lang` is not passed or the term has no translation for it.
   */
  langBookCount?: number;
  /**
   * CategoryTranslation.autoIndexable (hysteresis state) for the requested `lang`.
   * Undefined when `lang` is not passed or the term has no translation for it.
   */
  autoIndexable?: boolean;
  indexable: boolean;
  isVisible: boolean;
  sortOrder: number;
  translations?: Array<{
    language: string;
    name: string;
    slug: string;
    bookCount?: number;
    autoIndexable?: boolean;
  }>;
  children: CategoryTreeNode[];
};

/**
 * Сообщение о нарушенной уникальности, называющее то поле, по которому
 * ограничение действительно существует.
 *
 * 🔴 `LEGACY-311`. Прежний текст был один на все случаи — «Category with same
 * slug already exists», — и он был неверен всегда: индекса на `Category.slug`
 * в схеме нет с миграции `20250830151000_add_taxonomy_translations`, `@unique`
 * стоит только на `key`. То есть `P2002` сюда приходил **по ключу**, а оператор
 * читал про слаг: менял слаг и получал тот же 400 сколько угодно раз.
 *
 * Поле берётся из `meta.target` самого отказа, а не из имени переменной рядом:
 * прежний текст пережил удаление собственного индекса на четыре года именно
 * потому, что сверять его было не с чем.
 *
 * ⚠️ Текст виден клиенту, но контрактом не является: фронт разбирает отказ
 * по HTTP-коду (`books-front/lib/errors.ts`), а форма создания категории
 * узнаёт про занятый слаг заранее, из `GET /categories/check-slug`.
 * Код ответа при этом не меняется — 400, как и был.
 */
function uniqueViolationMessage(error: Prisma.PrismaClientKnownRequestError): string {
  const target = error.meta?.target;
  const fields = Array.isArray(target)
    ? target.map(String)
    : typeof target === 'string'
      ? [target]
      : [];
  if (fields.includes('key')) return 'Category with same key already exists';
  if (fields.includes('slug')) return 'Category with same slug already exists';
  if (fields.length > 0) return `Category with same ${fields.join(', ')} already exists`;
  return 'Category violates a uniqueness constraint';
}

@Injectable()
export class CategoryService {
  constructor(
    private prisma: PrismaService,
    private readonly slugRedirects: SlugRedirectService,
    private readonly categoryTree: CategoryTreeService,
    @Optional()
    private readonly taxonomyIndexabilityService?: TaxonomyIndexabilityService,
  ) {}

  async list(page = 1, limit = 20, type?: PrismaCategory['type'], lang?: Language) {
    const where: Prisma.CategoryWhereInput = {};
    if (type) {
      where.type = type;
    }
    const skip = (page - 1) * limit;
    const [total, items] = await this.prisma.$transaction([
      this.prisma.category.count({ where }),
      this.prisma.category.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' } as any, { name: 'asc' }],
        skip,
        take: limit,
        include: {
          translations: {
            select: {
              language: true,
              name: true,
              slug: true,
              // Consumed by the frontend sitemap route, which picks a translation
              // by language and must decide indexability from the same signal as
              // meta robots. See CategoryTranslationResponse.
              bookCount: true,
              autoIndexable: true,
            },
          },
        },
      }),
    ]);

    // Get distinct book counts for these categories (optionally filtered by language)
    const categoryIds = items.map((item) => item.id);

    // 🔴 `Prisma.join([])` бросает TypeError **в момент сборки условия**, а не при
    // запросе, и наружу это выходит как 500 на штатном пути: страница за пределами
    // выборки, фильтр без совпадений, язык без переводов, пустая база нового
    // окружения. Ранний выход обязан стоять до сборки `whereConditions`.
    if (categoryIds.length === 0) {
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

    const whereConditions: Prisma.Sql[] = [
      Prisma.sql`bc."categoryId" IN (${Prisma.join(categoryIds)})`,
      Prisma.sql`bv.status = 'published'`,
    ];
    if (lang) {
      whereConditions.push(Prisma.sql`bv.language = ${lang}::"Language"`);
    }
    const bookCounts = await this.prisma.$queryRaw<
      Array<{ categoryId: string; booksCount: number }>
    >`
      SELECT bc."categoryId", COUNT(DISTINCT bv."bookId")::int as "booksCount"
      FROM "BookCategory" bc
      JOIN "BookVersion" bv ON bc."bookVersionId" = bv.id
      WHERE ${Prisma.join(whereConditions, ' AND ')}
      GROUP BY bc."categoryId"
    `;
    const countMap = new Map(bookCounts.map((row) => [row.categoryId, row.booksCount]));

    const data = items.map((item) => {
      // Same projection as getTree: the requested language's indexability signals,
      // or undefined when there is no lang / no translation into it.
      const langTranslation = lang ? item.translations.find((t) => t.language === lang) : undefined;

      return {
        id: item.id,
        name: item.name,
        slug: item.slug,
        key: item.key,
        type: item.type,
        booksCount: countMap.get(item.id) || 0,
        langBookCount: langTranslation?.bookCount,
        autoIndexable: langTranslation?.autoIndexable,
        indexable: item.indexable ?? true,
        isVisible: item.isVisible ?? true,
        sortOrder: item.sortOrder ?? 0,
        translations: item.translations,
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

  async create(dto: CreateCategoryDto) {
    const data: Prisma.CategoryCreateInput = {
      type: dto.type,
      name: dto.name,
      slug: dto.slug,
      key: dto.key || dto.slug,
      ...(dto.indexable !== undefined ? { indexable: dto.indexable } : {}),
      ...(dto.isVisible !== undefined ? { isVisible: dto.isVisible } : {}),
      ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      ...(dto.parentId ? { parent: { connect: { id: dto.parentId } } } : {}),
    };

    // Термин без родителя ребра не пишет: блокировать нечего, и брать её здесь
    // значило бы сериализовать массовое заведение корневых терминов на общей
    // очереди импорта (`LEGACY-274`).
    //
    // 🔴 Гонка «проверил и записал» здесь **не закрыта**, и транзакция её
    // не закрывает: на READ COMMITTED две одновременные вставки не видят
    // незакоммиченных строк друг друга, `FOR UPDATE` тут не на чем брать,
    // а уникального индекса на `Category.slug` в схеме нет — он снесён
    // миграцией `20250830151000_add_taxonomy_translations`. Два одновременных
    // `POST` с одним слагом и разными ключами пройдут оба. Рубеж в базе
    // заводит `LEGACY-276`, и до неё проверка остаётся соглашением кода.
    // Решение арбитра от 29.08.2026, строка в `decisions-log.md`.
    //
    // Транзакция всё равно нужна: она держит инвариант «проверка ходит
    // клиентом записи», на котором этот рубеж потом и строится.
    if (!dto.parentId) {
      return this.categoryTree.runInTree(async (tx) => {
        await this.assertSlugFree(tx, dto.slug);
        return this.createCategoryRow(() => tx.category.create({ data }));
      });
    }

    const parentId = dto.parentId;
    // 🔴 `LEGACY-274`. `create` — такой же писатель родительского ребра, как
    // `update`, и до 29.08.2026 он был единственным, кто блокировку не брал:
    // родитель читался на пуле, а запись шла вовсе без транзакции. Пока это
    // было так, одновременные `POST /categories {parentId: P}` и
    // `PATCH /categories/P {type}` записывали разнотипное ребро мимо
    // блокировки: `create` проверял тип по чтению, устаревшему к моменту записи.
    //
    // Порядок «блокировка первым оператором» держит теперь не комментарий,
    // а `runInLockedTree`: тело получает `tx`, на котором блокировка уже
    // стоит (`LEGACY-310`).
    return this.categoryTree.runInLockedTree(async (tx) => {
      // Родитель перечитывается клиентом записи: строка, прочитанная на пуле,
      // к этому месту уже могла сменить тип.
      const parent = await tx.category.findUnique({
        where: { id: parentId },
        select: { id: true, type: true },
      });
      if (!parent) throw new BadRequestException('Parent category not found');
      // Цикла на создании быть не может — у нового термина ещё нет потомков, —
      // но правило о типах то же, что на `update` и на импорте, и живёт оно
      // в одном месте (`LEGACY-264`).
      this.categoryTree.assertSameType(dto.type, parent.type);
      await this.assertSlugFree(tx, dto.slug);

      return this.createCategoryRow(() => tx.category.create({ data }));
    });
  }

  /**
   * Свободен ли базовый слаг термина.
   *
   * 🔴 `LEGACY-311`. Уникальности на `Category.slug` в схеме нет: индекс
   * `Category_slug_key` снесён миграцией `20250830151000_add_taxonomy_translations`
   * (`LEGACY-276`), и `@unique` остался только на `key`. Значит занятость слага —
   * это соглашение, которое обязан держать код, и держать его должны **оба**
   * пути записи. До 29.08.2026 проверка стояла только в `update`, а `create`
   * заводил второй термин на тот же публичный адрес с ответом 201.
   *
   * ⚠️ От гонки это не защищает и защищать не может: уникальности на
   * `Category.slug` в базе нет, поэтому два одновременных запроса с одним
   * слагом пройдут оба. Проверка ловит обычный случай — оператора, который
   * заводит термин на занятый адрес. Настоящий рубеж — уникальный индекс
   * из `LEGACY-276`.
   *
   * Клиент передаётся аргументом: `create` зовёт клиентом своей транзакции,
   * `update` — пулом, до её открытия. Перенос второго внутрь транзакции —
   * тело `LEGACY-276`.
   */
  private async assertSlugFree(db: PrismaLike, slug: string, exceptId?: string): Promise<void> {
    const dup = await db.category.findFirst({
      where: exceptId ? { slug, NOT: { id: exceptId } } : { slug },
      select: { id: true },
    });
    if (dup) throw new BadRequestException('Category with same slug already exists');
  }

  /**
   * Запись строки **самого термина** и только её: `P2002` по ключу таксономии —
   * это занятый адрес, то есть 400, а не 500.
   *
   * ⚠️ Вынесено отдельно потому, что запись идёт из двух мест — с блокировкой
   * и без неё, — а вторая копия `catch` разошлась бы с первой при первой правке
   * текста ошибки. Переводы сюда не заводить: у `createTranslation` свой текст
   * ошибки и свой откат `seo`, и общий обработчик подменил бы сообщение
   * про занятую пару «язык — слаг» сообщением про слаг термина.
   */
  private async createCategoryRow<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (e: unknown) {
      const known = e as Prisma.PrismaClientKnownRequestError;
      if (known.code === 'P2002') {
        throw new BadRequestException(uniqueViolationMessage(known));
      }
      throw e;
    }
  }

  async update(id: string, dto: UpdateCategoryDto) {
    const exists = await this.prisma.category.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Category not found');

    // 🔴 `key` — единственный неизменяемый ключ таксономии: по нему связывает
    // JSON-импорт (`import.service.ts` ищет термин через `findUnique({ key })`),
    // и уехавший ключ там не ошибка, а **дубликат**: импорт не находит термин,
    // заводит новый, а прежний остаётся жить со своими переводами и связями.
    // Отчёт при этом покажет `imported`, а не ошибку.
    //
    // Правило 3 `agent-rules.md` требует для такой роли неизменяемое поле, а не
    // дисциплину «не трогайте это». Поэтому смена отвергается здесь, а не
    // запрещается в форме: форма — лишь один из клиентов.
    //
    // ⚠️ Совпадающий `key` пропускается молча и намеренно: админка отправляет его
    // в каждом PATCH, и 400 на неизменённое значение сломал бы редактирование,
    // ничего не защитив.
    if (dto.key !== undefined && dto.key !== exists.key) {
      throw new BadRequestException(
        `Category key is immutable: it is the only stable identifier of the term. ` +
          `Attempted to change "${exists.key}" to "${dto.key}".`,
      );
    }
    // Проверка идёт тем же хелпером, что и в `create`: правило занятости слага
    // одно, и второй его копии в этом файле быть не должно (`LEGACY-311`).
    //
    // ⚠️ Клиент здесь — пул, а не транзакция, и это не описка: перенос этой
    // проверки внутрь транзакции — тело `LEGACY-276`, а не этой записи.
    if (dto.slug) {
      await this.assertSlugFree(this.prisma, dto.slug, id);
    }
    // 🔴 `LEGACY-274`. Блокировка — **первым** оператором транзакции, до любого
    // чтения и любой записи: транзакция, успевшая взять строку категории,
    // встала бы во взаимную блокировку с чужой. Порядок держит теперь
    // `runInLockedTree`, а не комментарий у места вызова (`LEGACY-310`).
    //
    // ⚠️ Условие считается по телу запроса, а не по строке из базы: чтобы
    // узнать про базу, надо её прочитать, а чтение до блокировки лишает
    // блокировку смысла. Ни `parentId`, ни `type` в теле — правка дерева
    // не касается, и брать блокировку не на что; такая транзакция идёт через
    // `runInTree` — те же границы, без очереди.
    //
    // 🔴 Безусловный вызов стоил бы ожидания там, где ждать нечего: импорт
    // держит эту же блокировку на каждый термин (`CATEGORY_TREE_TX_OPTIONS` —
    // потолок 30 с), и `PATCH {name}` встал бы на ней **внутри своей
    // транзакции**, удерживая соединение единственного пула (`LEGACY-256`);
    // упёршись в потолок — `P2028` и 500 вместо 200.
    //
    // ⚠️ Условие «поле пришло», а не «значение изменилось», и это не описка:
    // узнать фактическое значение можно только чтением, а чтение до блокировки
    // лишает её смысла. Клиент, шлющий сущность целиком (админка так и делает —
    // см. блок про `key` выше), приложит `type` и на переименовании, то есть
    // блокировку всё-таки возьмёт. Дешевле это не делается без чтения до
    // блокировки; ожидание при этом идёт на одном термине импорта, а не на всей
    // партии — она обрабатывается последовательно, транзакцией на термин.
    const touchesTree = dto.parentId !== undefined || dto.type !== undefined;

    const body = async (tx: Prisma.TransactionClient) => {
      // 🔴 `LEGACY-274`. Термин перечитывается **внутри** транзакции, и `type`
      // со `slug` берутся отсюда, а не из до-транзакционного `exists`. Тот
      // читался на клиенте пула и к этому месту уже устаревал: соседний PATCH,
      // сменивший тип, давал проверку родителя по старому типу — ровно ту
      // разнотипную связь, которую стерегут `LEGACY-264` и `LEGACY-005`, — а
      // запись редиректа уходила с уже не того слага.
      //
      // Проверка существования при этом не дублирующая: между чтением на пуле
      // и этим местом термин мог быть удалён.
      const current = await tx.category.findUnique({
        where: { id },
        select: { id: true, type: true, slug: true, parentId: true },
      });
      if (!current) throw new NotFoundException('Category not found');

      // Базовый слаг участвует в резолве публичного URL как фолбэк, поэтому его смена
      // ломает адрес во всех языках сразу (LEGACY-062). Запись — в той же транзакции.
      const baseSlugChanged = !!dto.slug && dto.slug !== current.slug;
      const nextType = dto.type ?? current.type;

      // parent validations
      //
      // 🔴 `LEGACY-266`. Чтение родителя и проверка идут **тем же клиентом**,
      // которым делается запись. На клиенте пула между проверкой и `update`
      // помещалась чужая транзакция; тот же порядок держит импорт
      // (`import.service.ts`, `updateParentId`).
      //
      // 🔴 `LEGACY-275`. Условие зависит не от наличия `parentId` в теле запроса,
      // а от того, меняется ли что-то из пары «родитель, тип». Прежнее
      // `if (dto.parentId)` пропускало второй путь к той же порче данных:
      // `PATCH { "type": "category" }` без `parentId` не запускал проверку вовсе,
      // но тип записывался — и термин оставался ребром под родителем чужого типа,
      // то есть пропадал из своего дерева и всплывал корнем в чужом.
      //
      // ⚠️ Родитель берётся фактический: из тела запроса, когда `parentId` пришёл,
      // и из базы, когда меняется только тип. `parentId: null` — это отвязка,
      // проверять там нечего.
      const parentIdChanging =
        typeof dto.parentId !== 'undefined' && dto.parentId !== current.parentId;
      const typeChanging = dto.type !== undefined && dto.type !== current.type;
      const effectiveParentId =
        typeof dto.parentId === 'undefined' ? current.parentId : dto.parentId;

      if ((parentIdChanging || typeChanging) && effectiveParentId) {
        const parent = await tx.category.findUnique({
          where: { id: effectiveParentId },
          select: { id: true, type: true },
        });
        if (!parent) throw new BadRequestException('Parent category not found');
        // Самоссылка, тип и цикл — одним условием на оба пути записи: тот же вызов
        // делает JSON-импорт (`LEGACY-263`, `LEGACY-264`). Своей копии этих трёх
        // проверок здесь больше нет — расходящиеся комплекты правил о допустимых
        // сочетаниях типов уже разбирались как `LEGACY-005`.
        await this.categoryTree.assertParentAllowed(
          { id, type: nextType },
          { id: parent.id, type: parent.type },
          tx,
        );
      }

      // 🔴 `LEGACY-303`. Второй край того же ребра. Проверка выше смотрит только
      // вверх и только при непустом родителе, поэтому `PATCH` одного `type`
      // на корневом термине с детьми проходил с 200, а в базе оставались
      // рёбра `C(genre) → P(category)`: дети всплывали корнями в своём
      // дереве, сам термин стоял без детей в чужом.
      //
      // Ветка «детей нет» обязана проходить, и ветка «дети уже нужного типа»
      // тоже: иначе запрет накрыл бы починку уже испорченного дерева.
      if (typeChanging) {
        await this.categoryTree.assertChildTypesAllowed({ id, type: nextType }, tx);
      }

      if (baseSlugChanged && dto.slug) {
        await this.slugRedirects.recordBaseSlugChange('category', current.slug, dto.slug, tx);
      }

      return tx.category.update({
        where: { id },
        data: {
          type: dto.type,
          name: dto.name,
          slug: dto.slug,
          // `key` намеренно отсутствует: он неизменяем, а прежняя ветка
          // `dto.slug -> key` молча делала слаг ключом при PATCH без `key`,
          // то есть переименование ради URL уводило за собой опорный ключ.
          ...(dto.indexable !== undefined ? { indexable: dto.indexable } : {}),
          ...(dto.isVisible !== undefined ? { isVisible: dto.isVisible } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
          ...(typeof dto.parentId === 'undefined'
            ? {}
            : dto.parentId
              ? { parent: { connect: { id: dto.parentId } } }
              : { parent: { disconnect: true } }),
        },
      });
    };

    // Границы транзакции больше не переписываются здесь литералом: подъём по
    // предкам идёт внутри транзакции и стоит до `CATEGORY_TREE_MAX_DEPTH`
    // последовательных чтений, поэтому потолок обязан совпадать с импортным —
    // теперь он один на всех писателей дерева (`CATEGORY_TREE_TX_OPTIONS`).
    return touchesTree
      ? this.categoryTree.runInLockedTree(body)
      : this.categoryTree.runInTree(body);
  }

  /**
   * 🔴 `LEGACY-306`. Три записи подряд — это `$transaction`, а не три
   * независимых `await` на клиенте пула. Обрыв между второй и третьей оставлял
   * термин без переводов и без связей с книгами: он не показывался ни на одной
   * языковой версии сайта (публичные маршруты отбирают по `CategoryTranslation`
   * нужного языка), но продолжал занимать `slug` и `key` и попадать в дерево.
   * Ровно та половинчатая запись, ради запрета которой заведены `LEGACY-131`
   * и `LEGACY-257` в импорте.
   *
   * 🔴 Удаление — тоже правка дерева, поэтому блокировка берётся первым
   * оператором: проверка «есть дети» шла на пуле до записей, и ребёнок,
   * заведённый между ней и `delete`, оставался с `parentId` на удалённую
   * строку. Порядок держит `runInLockedTree` (`LEGACY-310`).
   */
  async remove(id: string) {
    return this.categoryTree.runInLockedTree(async (tx) => {
      const exists = await tx.category.findUnique({ where: { id }, select: { id: true } });
      if (!exists) throw new NotFoundException('Category not found');

      const childrenCount = await tx.category.count({ where: { parentId: id } });
      if (childrenCount > 0) {
        throw new BadRequestException('Cannot delete category with children');
      }

      await tx.bookCategory.deleteMany({ where: { categoryId: id } });
      await tx.categoryTranslation.deleteMany({ where: { categoryId: id } });

      return tx.category.delete({ where: { id } });
    });
  }

  async getBySlugWithBooks(slug: string, queryLang?: string, acceptLanguageHeader?: string) {
    const headerLang = acceptLanguageHeader || null;
    const preferred = resolveRequestedLanguage({
      queryLang,
      acceptLanguage: headerLang,
      available: [],
    });

    const trans = await this.prisma.categoryTranslation.findUnique({
      where: { language_slug: { language: preferred ?? Language.en, slug } },
      include: { category: true, seo: true },
    });
    let category: PrismaCategory | null =
      trans && 'category' in trans ? ((trans.category as PrismaCategory | null) ?? null) : null;
    if (!category) {
      // Fallback to base category by slug for backward compatibility
      category = await this.prisma.category.findFirst({ where: { slug } });
      if (!category) throw new NotFoundException('Category not found');
    }

    // Public endpoint: only published versions
    //
    // ⚠️ Комментарий выше стоял здесь и до 10.08.2026 — но описывал намерение,
    // а не код: `status` проверялся только в `where`, отбирая книгу, тогда как
    // `include` тянул все её версии целиком (`LEGACY-090`). Комментарий,
    // утверждающий то, чего рядом не делается, вреднее его отсутствия.
    const books = await this.prisma.book.findMany({
      where: {
        versions: {
          some: {
            status: 'published',
            categories: { some: { categoryId: category.id } },
          },
        },
      },
      select: {
        ...PUBLIC_BOOK_SELECT,
        versions: {
          where: { status: 'published' },
          select: {
            ...PUBLIC_BOOK_VERSION_SELECT,
            tags: {
              select: {
                tag: {
                  include: {
                    translations: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const allVersions = books.flatMap((b) => b.versions);
    const availableLanguages: Language[] = Array.from(new Set(allVersions.map((v) => v.language)));
    const effective = resolveRequestedLanguage({
      queryLang,
      acceptLanguage: acceptLanguageHeader || null,
      available: availableLanguages,
    });

    const filteredBooks = effective
      ? books.filter((b) => b.versions.some((v) => v.language === effective))
      : books;

    const ratings = await this.prisma.bookRating.groupBy({
      by: ['bookId'],
      _avg: { score: true },
    });
    const ratingMap = new Map(ratings.map((r) => [r.bookId, r._avg.score]));
    const data = filteredBooks.map((book) => ({
      ...book,
      rating: ratingMap.get(book.id) ?? null,
    }));

    return {
      category: {
        ...category,
        translation: trans ?? null,
        description: trans?.description ?? null,
      },
      seo: trans?.seo ?? null,
      data,
      meta: {
        total: filteredBooks.length,
        page: 1,
        limit: 100,
        totalPages: 1,
      },
      availableLanguages,
    };
  }

  // Public resolver by path language and translation slug (/:lang/categories/:slug/books)
  async getByLangSlugWithBooks(pathLang: Language, slug: string) {
    let trans = await this.prisma.categoryTranslation.findUnique({
      where: { language_slug: { language: pathLang, slug } },
      include: { category: true, seo: true },
    });
    let category: PrismaCategory | null =
      trans && 'category' in trans ? ((trans.category as PrismaCategory | null) ?? null) : null;
    if (!category) {
      // Fallback to base category by slug OR id if slug is a UUID
      category = await this.prisma.category.findFirst({
        where: {
          OR: [
            { slug },
            ...(slug.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
              ? [{ id: slug }]
              : []),
          ],
        },
      });
      if (!category) throw new NotFoundException('Category not found');

      // Fetch the translation using the category ID we just resolved
      trans = await this.prisma.categoryTranslation.findFirst({
        where: { categoryId: category.id, language: pathLang },
        include: { category: true, seo: true },
      });
    }

    const books = await this.prisma.book.findMany({
      where: {
        versions: {
          some: {
            status: 'published',
            language: pathLang,
            categories: { some: { categoryId: category.id } },
          },
        },
      },
      select: {
        ...PUBLIC_BOOK_SELECT,
        // 🔴 `status: 'published'` выше отбирает **книгу**, а не её версии. Пока
        // здесь стоял голый `include`, к опубликованной книге прицеплялись все
        // её версии подряд — черновой перевод уезжал наружу и выглядел частью
        // живой книги (`LEGACY-090`). Фильтр нужен на каждом уровне, а не
        // только в `where` верхнего.
        versions: {
          where: { status: 'published' },
          select: {
            ...PUBLIC_BOOK_VERSION_SELECT,
            tags: {
              select: {
                tag: {
                  include: {
                    translations: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const availableLanguages: Language[] = Array.from(
      new Set(
        (
          await this.prisma.bookVersion.findMany({
            where: { status: 'published', categories: { some: { categoryId: category.id } } },
            select: { language: true },
          })
        ).map((v) => v.language),
      ),
    );

    const ratings = await this.prisma.bookRating.groupBy({
      by: ['bookId'],
      _avg: { score: true },
    });
    const ratingMap = new Map(ratings.map((r) => [r.bookId, r._avg.score]));
    const data = books.map((book) => ({
      ...book,
      rating: ratingMap.get(book.id) ?? null,
    }));

    return {
      category: {
        ...category,
        translation: trans ? { ...trans, category: undefined } : null,
        description: trans?.description ?? null,
        language: pathLang,
      },
      seo: trans?.seo ?? null,
      data,
      meta: {
        total: books.length,
        page: 1,
        limit: 100,
        totalPages: 1,
      },
      availableLanguages,
    };
  }

  // ===== Translations (Admin) =====
  listTranslations(categoryId: string) {
    return this.prisma.categoryTranslation.findMany({
      where: { categoryId },
      orderBy: { language: 'asc' },
      include: { seo: true },
    });
  }

  async createTranslation(categoryId: string, dto: CreateCategoryTranslationDto) {
    const exists = await this.prisma.category.findUnique({ where: { id: categoryId } });
    if (!exists) throw new NotFoundException('Category not found');

    let seoId: number | undefined;
    if (dto.seo) {
      const hasSeoData = Object.values(dto.seo).some((v) => v !== null && v !== undefined);
      if (hasSeoData) {
        const newSeo = await this.prisma.seo.create({ data: dto.seo });
        seoId = newSeo.id;
      }
    }

    try {
      return await this.prisma.categoryTranslation.create({
        data: {
          categoryId,
          language: dto.language,
          name: dto.name,
          slug: dto.slug,
          description: dto.description ?? null,
          // A brand-new term has no books yet, so it must not be born indexable.
          // Written explicitly rather than relying on the column default, which
          // is `true` — that default is what put every empty taxonomy into the
          // sitemap on 05.08.2026. The recompute opens the term once it earns it.
          bookCount: 0,
          autoIndexable: false,
          ...(dto.h1 !== undefined ? { h1: dto.h1 } : {}),
          ...(dto.shortDescription !== undefined ? { shortDescription: dto.shortDescription } : {}),
          ...(dto.metaTitle !== undefined ? { metaTitle: dto.metaTitle } : {}),
          ...(dto.metaDescription !== undefined ? { metaDescription: dto.metaDescription } : {}),
          ...(dto.ogTitle !== undefined ? { ogTitle: dto.ogTitle } : {}),
          ...(dto.ogDescription !== undefined ? { ogDescription: dto.ogDescription } : {}),
          ...(dto.ogImageUrl !== undefined ? { ogImageUrl: dto.ogImageUrl } : {}),
          ...(dto.ogImageAlt !== undefined ? { ogImageAlt: dto.ogImageAlt } : {}),
          ...(dto.faq !== undefined ? { faq: dto.faq } : {}),
          ...(seoId !== undefined ? { seoId } : {}),
        },
        include: { seo: true },
      });
    } catch (e: any) {
      if (seoId) {
        await this.prisma.seo.delete({ where: { id: seoId } }).catch(() => {});
      }
      if ((e as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        throw new BadRequestException('Translation with same (language, slug) already exists');
      }
      throw e;
    }
  }

  async updateTranslation(
    categoryId: string,
    language: Language,
    dto: UpdateCategoryTranslationDto,
  ) {
    const tr = await this.prisma.categoryTranslation.findUnique({
      where: { categoryId_language: { categoryId, language } },
    });
    if (!tr) throw new NotFoundException('Translation not found');

    if (dto.slug) {
      const dup = await this.prisma.categoryTranslation.findFirst({
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
          await this.prisma.seo.update({ where: { id: tr.seoId }, data: dto.seo });
          finalSeoId = tr.seoId;
        } else {
          const newSeo = await this.prisma.seo.create({ data: dto.seo });
          finalSeoId = newSeo.id;
        }
      } else if (tr.seoId) {
        finalSeoId = null;
        await this.prisma.seo.delete({ where: { id: tr.seoId } });
      }
    }

    // Смена слага и запись редиректа — одна транзакция (LEGACY-062). Порознь
    // существовал бы момент, когда слаг уже новый, а старый адрес ведёт в 404.
    const slugChanged = !!dto.slug && dto.slug !== tr.slug;

    return this.prisma.$transaction(async (tx) => {
      if (slugChanged && dto.slug) {
        await this.slugRedirects.record(
          { entityType: 'category', language, oldSlug: tr.slug, newSlug: dto.slug },
          tx,
        );
      }

      return tx.categoryTranslation.update({
        where: { categoryId_language: { categoryId, language } },
        data: {
          name: dto.name,
          slug: dto.slug,
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.h1 !== undefined ? { h1: dto.h1 } : {}),
          ...(dto.shortDescription !== undefined ? { shortDescription: dto.shortDescription } : {}),
          ...(dto.metaTitle !== undefined ? { metaTitle: dto.metaTitle } : {}),
          ...(dto.metaDescription !== undefined ? { metaDescription: dto.metaDescription } : {}),
          ...(dto.ogTitle !== undefined ? { ogTitle: dto.ogTitle } : {}),
          ...(dto.ogDescription !== undefined ? { ogDescription: dto.ogDescription } : {}),
          ...(dto.ogImageUrl !== undefined ? { ogImageUrl: dto.ogImageUrl } : {}),
          ...(dto.ogImageAlt !== undefined ? { ogImageAlt: dto.ogImageAlt } : {}),
          ...(dto.faq !== undefined ? { faq: dto.faq } : {}),
          ...(finalSeoId !== undefined ? { seoId: finalSeoId } : {}),
        },
        include: { seo: true },
      });
    });
  }

  async deleteTranslation(categoryId: string, language: Language) {
    const tr = await this.prisma.categoryTranslation.findUnique({
      where: { categoryId_language: { categoryId, language } },
    });
    if (!tr) return { success: true };

    await this.prisma.$transaction(async (tx) => {
      await tx.categoryTranslation.delete({
        where: { categoryId_language: { categoryId, language } },
      });
      if (tr.seoId) {
        await tx.seo.delete({ where: { id: tr.seoId } });
      }
    });

    return { success: true };
  }

  async attachCategoryToVersion(versionId: string, categoryId: string) {
    const [version, category] = await Promise.all([
      this.prisma.bookVersion.findUnique({
        where: { id: versionId },
        select: { id: true, bookId: true },
      }),
      this.prisma.category.findUnique({ where: { id: categoryId } }),
    ]);
    if (!version) throw new NotFoundException('BookVersion not found');
    if (!category) throw new NotFoundException('Category not found');

    const siblings = await this.prisma.bookVersion.findMany({
      where: { bookId: version.bookId },
      select: { id: true },
    });

    await this.prisma.$transaction(async (tx) => {
      for (const sibling of siblings) {
        const exists = await tx.bookCategory.findFirst({
          where: { bookVersionId: sibling.id, categoryId },
          select: { id: true },
        });
        if (!exists) {
          await tx.bookCategory.create({
            data: { bookVersionId: sibling.id, categoryId },
          });
        }
      }
    });

    // The link now exists for every language of the book, so every language's
    // counter for this term is stale.
    await this.taxonomyIndexabilityService?.recomputeForTerms([categoryId], []);

    return this.prisma.bookCategory.findFirst({
      where: { bookVersionId: versionId, categoryId },
    });
  }

  async detachCategoryFromVersion(versionId: string, categoryId: string) {
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
        const link = await tx.bookCategory.findFirst({
          where: { bookVersionId: sibling.id, categoryId },
        });
        if (link) {
          await tx.bookCategory.delete({ where: { id: link.id } });
        }
      }
    });

    // Must run after the delete and by term id: the version no longer points at
    // this category, so a version-scoped recompute would miss exactly it.
    await this.taxonomyIndexabilityService?.recomputeForTerms([categoryId], []);

    return { success: true };
  }

  // ===== Hierarchy helpers =====
  /**
   * Returns the full category tree — **all** terms, including hidden and
   * non-indexable ones, because the admin UI needs them. Filtering for public
   * rendering is the client's responsibility: see `isTaxonomyLinkable` in
   * `books-front/lib/seo/taxonomy-linkable.ts`.
   *
   * When `lang` is passed, every node also carries `langBookCount` and
   * `autoIndexable` projected from that language's translation, so the client
   * can decide "may I link to this term" with the same signal that drives
   * meta robots and the sitemap. Without `lang`, or for a node that has no
   * translation into `lang`, both fields stay `undefined` — never a value
   * borrowed from an arbitrary other language.
   */
  async getTree(type?: PrismaCategory['type'], lang?: Language): Promise<CategoryTreeNode[]> {
    type CategoryNode = CategoryTreeNode;

    // Build where clause for optional type filter
    const where: Prisma.CategoryWhereInput = {};
    if (type) {
      where.type = type;
    }

    // Fetch all categories

    const allCategories = await this.prisma.category.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        slug: true,
        key: true,
        type: true,
        parentId: true,
        indexable: true,
        isVisible: true,
        sortOrder: true,
        translations: {
          select: {
            language: true,
            name: true,
            slug: true,
            bookCount: true,
            autoIndexable: true,
          },
        },
      },
    });

    // Count distinct books per category (not versions), optionally filtered by language
    const treeWhereConditions: Prisma.Sql[] = [Prisma.sql`bv.status = 'published'`];
    if (lang) {
      treeWhereConditions.push(Prisma.sql`bv.language = ${lang}::"Language"`);
    }
    const bookCounts = await this.prisma.$queryRaw<
      Array<{ categoryId: string; booksCount: number }>
    >`
      SELECT bc."categoryId", COUNT(DISTINCT bv."bookId")::int as "booksCount"
      FROM "BookCategory" bc
      JOIN "BookVersion" bv ON bc."bookVersionId" = bv.id
      WHERE ${Prisma.join(treeWhereConditions, ' AND ')}
      GROUP BY bc."categoryId"
    `;

    const countMap = new Map(bookCounts.map((row) => [row.categoryId, row.booksCount]));

    const byId = new Map<string, CategoryNode>(
      allCategories.map((c) => {
        // Project the requested language's indexability signals onto the node.
        // No lang, or no translation for it → both stay undefined.
        const langTranslation = lang ? c.translations.find((t) => t.language === lang) : undefined;

        return [
          c.id,
          {
            id: c.id,
            name: c.name,
            slug: c.slug,
            key: c.key,
            type: c.type,
            parentId: c.parentId,
            booksCount: countMap.get(c.id) || 0,
            langBookCount: langTranslation?.bookCount,
            autoIndexable: langTranslation?.autoIndexable,
            indexable: c.indexable ?? true,
            isVisible: c.isVisible ?? true,
            sortOrder: c.sortOrder ?? 0,
            translations: c.translations,
            children: [],
          } as CategoryNode,
        ];
      }),
    );
    const roots: CategoryNode[] = [];
    for (const c of byId.values()) {
      if (c.parentId && byId.has(c.parentId)) {
        byId.get(c.parentId)!.children.push(c);
      } else {
        roots.push(c);
      }
    }
    return roots;
  }

  async getChildren(id: string) {
    const exists = await this.prisma.category.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Category not found');
    return this.prisma.category.findMany({ where: { parent: { id } }, orderBy: { name: 'asc' } });
  }

  async getAncestors(id: string) {
    const node = await this.prisma.category.findUnique({
      where: { id },
      select: { parentId: true },
    });
    if (!node) throw new NotFoundException('Category not found');
    const path: Array<{
      id: string;
      name: string;
      slug: string;
      type: PrismaCategory['type'];
      parentId: string | null;
    }> = [];
    // Подъём — в `CategoryTreeService`: у него есть потолок глубины и множество
    // посещённых, без которых замкнутое дерево вешает запрос навсегда
    // (`LEGACY-263`). Петля в базе возможна и сейчас: её мог оставить импорт
    // прежних версий.
    path.push(...(await this.categoryTree.collectAncestors(id, node.parentId)));
    // we collected from child->parent, need root->... order excluding the node itself
    return path.reverse();
  }

  async checkSlugExists(slug: string, excludeId?: string) {
    const where: Prisma.CategoryWhereInput = { slug };
    if (excludeId) {
      where.id = { not: excludeId };
    }
    return this.prisma.category.findFirst({
      where,
      select: { id: true, name: true, slug: true },
    });
  }

  async generateUniqueSuggestedSlug(baseSlug: string): Promise<string> {
    let counter = 1;
    let candidate = baseSlug;

    // Check if base slug exists
    let exists = await this.prisma.category.findFirst({ where: { slug: candidate } });

    while (exists) {
      counter++;
      candidate = `${baseSlug}-${counter}`;
      exists = await this.prisma.category.findFirst({ where: { slug: candidate } });
    }

    return candidate;
  }
}

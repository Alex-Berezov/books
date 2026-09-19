import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma, Category as PrismaCategory } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Клиент транзакции или обычный. Проверка связи «родитель — ребёнок» обязана
 * ходить тем же клиентом, что и запись, которую она стережёт: вызов на
 * `this.prisma` внутри чужой `$transaction` уходит на другое соединение и не
 * видит незакоммиченных строк этой транзакции.
 */
export type PrismaLike = Prisma.TransactionClient | PrismaService;

export type CategoryAncestor = {
  id: string;
  name: string;
  slug: string;
  type: PrismaCategory['type'];
  parentId: string | null;
};

/**
 * Потолок глубины подъёма по `parentId`.
 *
 * Не настройка и не вкус: таксономия проекта — жанры, категории и коллекции, где
 * реальная глубина измеряется единицами. Число выбрано заведомо недостижимым для
 * здорового дерева, чтобы обрыв означал именно порчу данных, а не глубокую ветку.
 */
export const CATEGORY_TREE_MAX_DEPTH = 64;

/**
 * Текст отказа «базовый слаг занят» — один на обе стороны одной и той же
 * ситуации (`LEGACY-311`, `LEGACY-276`).
 *
 * 🔴 Сторон именно две, и до 19.09.2026 они жили разными строками в разных
 * файлах: своя проверка (`assertSlugFree` ниже) и `P2002` от базы
 * (`uniqueViolationMessage` в `category.service.ts`). С релизом 2, который
 * заводит `@@unique([slug])`, обе станут достижимы на одном и том же запросе —
 * кто первым поймает, тот и ответит, — и разные тексты на одно событие были бы
 * видны оператору как две разные ошибки.
 */
export const CATEGORY_SLUG_TAKEN_MESSAGE = 'Category with same slug already exists';

/**
 * Ключ рекомендательной блокировки, сериализующей правку дерева категорий.
 * Значение произвольно, но постоянно: советующиеся стороны должны назвать одно
 * и то же число, иначе блокировки просто не встретятся.
 *
 * ⚠️ Наружу намеренно не выставлен. Публичный ключ читается как приглашение
 * написать `pg_advisory_xact_lock` мимо `lockTree` — то есть мимо трёх условий,
 * без которых блокировка молча ничего не стережёт (см. её doc-блок).
 */
const CATEGORY_TREE_LOCK_KEY = 8_314_270_001n;

/**
 * 🔴 `LEGACY-276`. Пространство имён двухаргументного
 * `pg_advisory_xact_lock(int4, int4)` для замка **по одному слагу**.
 *
 * Двухаргументная форма живёт в отдельном ключевом пространстве от
 * одноаргументной (bigint), поэтому с `CATEGORY_TREE_LOCK_KEY` не пересекается;
 * от `TAG_KEY_LOCK_NAMESPACE` (`tag-lock.service.ts`) отличается значением.
 * Наружу не выставлено по той же причине, что и ключ дерева: замок, взятый
 * мимо `lockCategorySlug`, ничего не стережёт.
 */
const CATEGORY_SLUG_LOCK_NAMESPACE = 831_427_003;

/**
 * Границы транзакции, которая правит дерево категорий.
 *
 * Одно значение на всех писателей, и это не вкус. Внутри такой транзакции идёт
 * ожидание на общей блокировке (`lockTree`), а держит её импорт — по транзакции
 * на термин. Писатель с меньшим потолком встаёт в ту же очередь, но упирается
 * в свой лимит раньше и отдаёт `P2028` и 500 вместо задуманного ответа.
 *
 * До 29.08.2026 значения лежали тремя копиями — `ImportService.TX_OPTIONS`
 * и два литерала в `CategoryService`, — а связь между ними держалась
 * комментарием «те же значения, что у импорта» (`LEGACY-310`).
 *
 * ⚠️ Транзакция удерживает соединение всё это время, а пул у приложения один
 * (`LEGACY-256`). Удлинять эти числа без нужды нельзя.
 */
export const CATEGORY_TREE_TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;

/**
 * Ребро, у которого тип ребёнка не совпал с типом родителя.
 *
 * `parent` — из базы, а не из ожидаемого типа узла: между записью и проверкой
 * родителя могли перетипизировать ещё раз, и вывод делается по тому, что в базе
 * сейчас. Поле необязательным не бывает: несовпадение считается относительно
 * родителя, и ребро без него в этот тип не попадает.
 */
export interface MismatchedChildEdge {
  key: string;
  type: PrismaCategory['type'];
  parent: { key: string; type: PrismaCategory['type'] };
}

/**
 * Общие правила и границы для **всех писателей таксономии**: подъём по дереву,
 * допустимость связи «родитель — ребёнок», занятость базового слага, границы
 * транзакции и оба замка — дерева и слага.
 *
 * Заведён по `LEGACY-263` и `LEGACY-264`. До него условий было два комплекта:
 * `CategoryService.update` проверял самоссылку, тип и цикл, а `ImportService`
 * не проверял ничего, кроме существования родителя, — и импорт замыкал дерево
 * там, где админский путь отвечал 400. Второй комплект правил о допустимых
 * сочетаниях типов — это `LEGACY-005`, поэтому условие живёт здесь одно.
 *
 * 🔴 С 19.09.2026 (`LEGACY-276`) здесь же `assertSlugFree` и замок по слагу,
 * и это не расширение не по теме: у правила про адрес те же два писателя —
 * админские ручки и JSON-импорт, — и своя копия у второго разошлась с первой
 * в день заведения. Имя класса уже от этого отстаёт; переименование стоит
 * правки всех мест вызова и отложено до того, как правил станет больше.
 *
 * ⚠️ Отсюда следствие для входа: транзакцию писателя таксономии открывает
 * `runInTree`/`runInLockedTree`, а не `$transaction` у места вызова. Только
 * так порядок замков и границы держатся конструкцией, а не дисциплиной
 * (`LEGACY-310`).
 */
@Injectable()
export class CategoryTreeService {
  private readonly logger = new Logger(CategoryTreeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 🔴 `LEGACY-274`. Сериализует смену родителя в дереве категорий на время
   * транзакции.
   *
   * `LEGACY-266` вернул инвариант «проверка ходит клиентом записи», но гонку
   * двух одновременных `PATCH A {parent: B}` и `PATCH B {parent: A}` это
   * не закрывало: при `read committed` каждый оператор внутри транзакции берёт
   * свежий снимок и чужих незакоммиченных строк не видит, а голые `SELECT`
   * подъёма никого не блокируют. Обе транзакции проходили проверку, обе
   * коммитились, дерево замыкалось.
   *
   * Здесь сериализуются именно «проверил — записал» целиком: `pg_advisory_xact_lock`
   * держится до конца транзакции, поэтому вторая сторона ждёт коммита первой
   * и поднимается уже по её дереву.
   *
   * ⚠️ Три условия, без любого из которых блокировка молча ничего не стережёт:
   *
   * 1. Клиент — обязательно транзакционный. На `PrismaService` эта же блокировка
   *    снимается автокоммитом того же запроса, то есть не доживает до записи.
   *    Отсюда `Prisma.TransactionClient` в сигнатуре, а не `PrismaLike`.
   * 2. Вызов — **первым** оператором транзакции. Транзакция, успевшая взять
   *    строку категории, встанет здесь во взаимную блокировку с чужой.
   * 3. Именно `xact`-вариант. Сессионный `pg_advisory_lock` остаётся на
   *    соединении пула после коммита и рано или поздно заклинит пул.
   *
   * Внутрь `assertParentAllowed` не встроено намеренно: подъём зовут и публичные
   * крошки (`SeoService.resolvePublic`), которым блокировка не нужна и вредна.
   */
  private async lockTree(tx: Prisma.TransactionClient): Promise<void> {
    // ⚠️ Вызов идёт из `FROM`, а не из списка выборки: `pg_advisory_xact_lock`
    // возвращает `void`, и на `SELECT pg_advisory_xact_lock(...)` клиент падает
    // на разборе столбца этого типа. Мок такого не показывает вовсе.
    await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(${CATEGORY_TREE_LOCK_KEY})`;
  }

  /**
   * 🔴 `LEGACY-276`. Сериализует пару «проверил слаг — записал» по **одному
   * слагу**, а не по всему дереву (решение арбитра 19.09.2026,
   * `decisions-log.md`).
   *
   * Уникальности на `Category.slug` в базе пока нет — индекс `Category_slug_key`
   * снесён миграцией `20250830151000_add_taxonomy_translations`, и вернёт его
   * релиз 2 этой записи. До тех пор `assertSlugFree` ловит только тот дубль,
   * который уже закоммичен: на `read committed` два одновременных писателя
   * одного слага не видят незакоммиченных строк друг друга и проходят проверку
   * оба. Замок закрывает именно это окно — второй ждёт коммита первого
   * и проверяет уже по его строке.
   *
   * ⚠️ Замка дерева здесь мало, и это не дублирование: его берут не все
   * писатели слага. `POST /categories` без `parentId` и `PATCH` без `type`
   * и `parentId` идут через `runInTree`, то есть мимо очереди дерева — иначе
   * переименование встало бы за партией импорта и отдало `P2028` вместо ответа
   * (`LEGACY-256`).
   *
   * ⚠️ Общей очереди на все слаги нет намеренно: писатели разных слагов
   * друг другу не мешают. Коллизия `hashtext` двух разных слагов лишь ставит
   * их в очередь друг за другом — целостность от неё не страдает.
   *
   * ⚠️ Порядок «дерево, затем слаг» держат входы `runIn*`, а не комментарий
   * у места вызова (`LEGACY-310`): путь, взявший слаг раньше дерева, встал бы
   * во взаимную блокировку с `runInLockedTree`.
   */
  private async lockCategorySlug(tx: Prisma.TransactionClient, slug: string): Promise<void> {
    // Хеш считается в SQL (`hashtext`), а не в JS: одна функция на всех
    // вызывающих. Вызов из `FROM` — как у `lockTree`, по той же причине.
    await tx.$queryRaw`SELECT true AS locked
      FROM pg_advisory_xact_lock(${CATEGORY_SLUG_LOCK_NAMESPACE}::int4, hashtext(${slug}::text))`;
  }

  /**
   * Свободен ли базовый слаг термина.
   *
   * 🔴 `LEGACY-276`. Правило живёт здесь, а не в `CategoryService`, потому что
   * писателей базового слага двое — админские ручки и JSON-импорт, — и своя
   * копия у второго разошлась с первой в день заведения: другой текст отказа
   * и отсутствующий `exceptId`. Ровно так расходились комплекты правил
   * о допустимых сочетаниях типов, пока `LEGACY-263`/`LEGACY-264` не свели
   * их сюда же.
   *
   * ⚠️ Настоящим рубежом эта проверка не является и до релиза 2 являться
   * не может: уникальности на `Category.slug` в базе нет. Пару
   * «проверил — записал» сериализует `lockCategorySlug` у всех писателей слага,
   * рубеж в базе заводит `@@unique([slug])` релизом 2 (`ADR-018`, класс 2).
   *
   * Клиент передаётся аргументом и намеренно остаётся `PrismaLike`: кроме
   * вызова клиентом транзакции у этой проверки есть второй, дешёвый — на пуле
   * до открытия транзакции, чтобы занятый слаг стоил 400 сразу и не занимал
   * замок дерева (`LEGACY-256`, решение арбитра 19.09.2026).
   */
  async assertSlugFree(db: PrismaLike, slug: string, exceptId?: string): Promise<void> {
    const dup = await db.category.findFirst({
      where: exceptId ? { slug, NOT: { id: exceptId } } : { slug },
      select: { id: true },
    });
    if (dup) throw new BadRequestException(CATEGORY_SLUG_TAKEN_MESSAGE);
  }

  /**
   * Единственный вход для транзакции, которая правит дерево категорий.
   *
   * 🔴 `LEGACY-310`. До 29.08.2026 три условия блокировки из четырёх держались
   * не конструкцией, а прозой: `lockTree` был публичным, и каждое из четырёх
   * мест вызова повторяло своим комментарием «первым оператором, тем же `tx`,
   * с теми же границами». Типом было закрыто одно условие из четырёх —
   * `Prisma.TransactionClient` в сигнатуре, — а пятый писатель получал верный
   * тип и зелёную сборку при неверном порядке.
   *
   * Здесь порядок закрыт вызовом: тело получает `tx`, на котором блокировка
   * уже стоит, и взять её раньше физически неоткуда — `lockTree` приватный.
   * Границы транзакции берутся отсюда же, а не переписываются вызывающим.
   *
   * ⚠️ Вызывать нужно **не всегда**. Транзакция, не пишущая ни одного ребра
   * дерева, встала бы в общую очередь просто так: импорт держит эту же
   * блокировку на каждый термин, и `PATCH {name}` ждал бы её внутри своей
   * транзакции, удерживая соединение единственного пула (`LEGACY-256`).
   * Для такой транзакции есть `runInTree`: те же границы, без блокировки.
   */
  async runInLockedTree<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    slugToLock?: string,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockTree(tx);
      // 🔴 `LEGACY-276`. Порядок «дерево, затем слаг» — один на всех писателей
      // и держится этой строкой, а не дисциплиной вызывающих: путь, берущий
      // слаг раньше дерева, встал бы во взаимную блокировку с этим.
      if (slugToLock) await this.lockCategorySlug(tx, slugToLock);
      return fn(tx);
    }, CATEGORY_TREE_TX_OPTIONS);
  }

  /**
   * Транзакция с теми же границами, но без блокировки дерева: для писателя,
   * который дерева не касается и потому ждать общей очереди не должен.
   *
   * Границы всё равно берутся отсюда: такая транзакция живёт рядом с той,
   * что блокировку держит, и на дефолтных 5000 мс Prisma упиралась бы в свой
   * потолок первой.
   *
   * 🔴 `LEGACY-276`. «Дерева не касается» не значит «замка не берёт вовсе»:
   * писатель базового слага сериализуется по слагу и здесь — иначе `POST`
   * корневого термина и `PATCH` одного слага оставались бы единственными
   * путями, которыми дубль заводится мимо всякой очереди.
   */
  async runInTree<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    slugToLock?: string,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      if (slugToLock) await this.lockCategorySlug(tx, slugToLock);
      return fn(tx);
    }, CATEGORY_TREE_TX_OPTIONS);
  }

  /**
   * Предки узла `nodeId` от ближайшего к дальнему; сам узел в результат не входит.
   *
   * `startParentId` передаётся отдельно: вызывающий и так читает узел, чтобы
   * отличить «нет такого» от «нет родителя», и повторный запрос здесь был бы
   * лишним на каждом вызове.
   *
   * ⚠️ `nodeId` кладётся в посещённые сразу. Иначе на петле `A → B → A` подъём
   * от `A` возвращает `[A, B]`, то есть **сам узел среди своих предков**, и
   * хлебные крошки рисуют категорию собственным родителем, а JSON-LD получает
   * самоссылочную цепочку.
   *
   * 🔴 Обход обязан иметь потолок и множество посещённых, даже когда все пути
   * записи цикл отвергают: петля в базе уже может лежать — её оставили прежние
   * версии импорта (`LEGACY-263`). Без потолка `while (current)` не завершается
   * никогда, а не «работает медленно»: соединение единственного пула
   * (`LEGACY-256`) удерживается до таймаута клиента.
   */
  async collectAncestors(
    nodeId: string,
    startParentId: string | null,
    db: PrismaLike = this.prisma,
  ): Promise<CategoryAncestor[]> {
    const path: CategoryAncestor[] = [];
    const seen = new Set<string>([nodeId]);
    let current: string | null = startParentId;

    for (let depth = 0; current && depth < CATEGORY_TREE_MAX_DEPTH; depth += 1) {
      if (seen.has(current)) {
        this.warnCycle(nodeId, current);
        return path;
      }
      seen.add(current);
      const parent: CategoryAncestor | null = await db.category.findUnique({
        where: { id: current },
        select: { id: true, name: true, slug: true, type: true, parentId: true },
      });
      if (!parent) return path;
      path.push(parent);
      current = parent.parentId;
    }

    if (current) this.warnDepth(nodeId);
    return path;
  }

  /**
   * Есть ли `maybeAncestorId` среди предков `nodeId`.
   *
   * Сам `nodeId` предком себе не считается — самоссылку вызывающий проверяет
   * отдельно (см. `assertParentAllowed`), потому что сообщение об ошибке у неё
   * своё и понятнее общего «цикл в иерархии».
   *
   * ⚠️ Ответов три, а не два. Подъём, упёршийся в чужую петлю или в потолок
   * глубины, **не знает** ответа: `verdict: 'unknown'` — это не «предка нет».
   * Разница видна только на испорченном дереве, и именно там она решающая:
   * страже, которая на таком дереве отвечает «нет», оператор чинит одно, а
   * дописывает второе (см. `assertParentAllowed`).
   */
  async isDescendant(
    nodeId: string,
    maybeAncestorId: string,
    db: PrismaLike = this.prisma,
  ): Promise<'yes' | 'no' | 'unknown'> {
    const seen = new Set<string>([nodeId]);
    let current: string | null = nodeId;

    for (let depth = 0; depth < CATEGORY_TREE_MAX_DEPTH; depth += 1) {
      const node: { parentId: string | null } | null = await db.category.findUnique({
        where: { id: current },
        select: { parentId: true },
      });
      if (!node?.parentId) return 'no';
      if (node.parentId === maybeAncestorId) return 'yes';
      if (seen.has(node.parentId)) {
        this.warnCycle(nodeId, node.parentId);
        return 'unknown';
      }
      seen.add(node.parentId);
      current = node.parentId;
    }

    this.warnDepth(nodeId);
    return 'unknown';
  }

  /**
   * Единственный источник истины о том, можно ли подвесить `child` под `parent`.
   *
   * Зовут оба пути записи: `CategoryService.update` (админка) и
   * `ImportService.updateParentId` (JSON-импорт). Условий три, и порядок важен:
   * самоссылка и несовпадение типа определяются на месте, а цикл стоит золотом
   * в запросах — его проверка идёт последней.
   */
  async assertParentAllowed(
    child: { id: string; type: PrismaCategory['type'] },
    parent: { id: string; type: PrismaCategory['type'] },
    db: PrismaLike = this.prisma,
  ): Promise<void> {
    if (parent.id === child.id) {
      throw new BadRequestException('Category cannot be parent of itself');
    }
    this.assertSameType(child.type, parent.type);
    const verdict = await this.isDescendant(parent.id, child.id, db);
    if (verdict === 'yes') {
      throw new BadRequestException('Cycle detected in category hierarchy');
    }
    // ⚠️ Страж, который на непрочитанном дереве отвечает «можно», хуже
    // отсутствующего: оператор, чинящий уже испорченную ветку, дописал бы
    // в неё второе ребро и считал бы, что починил. Ветка предков читается
    // до конца или связь не пишется вовсе.
    if (verdict === 'unknown') {
      throw new BadRequestException(
        'Category hierarchy above the new parent is corrupted or too deep to verify; ' +
          'fix the existing chain before attaching new terms to it',
      );
    }
  }

  /**
   * Дерево строится отдельно на каждый `type`: `getTree(type)` отбирает термины
   * по типу и связывает детей через `byId.has(c.parentId)`. Жанр под коллекцией
   * не виден правильно ни в одном дереве — в дереве жанров он всплывает корнем,
   * в дереве коллекций не появляется вовсе (`LEGACY-264`).
   *
   * Отдельным методом, а не строкой внутри `assertParentAllowed`, ради
   * `CategoryService.create`: там проверять цикл не на чем — у нового термина
   * ещё нет потомков, — а правило о типах то же самое, и второй его копии быть
   * не должно (`LEGACY-005`).
   */
  /**
   * Второй край того же ребра: можно ли оставить `node` его детям, если тип
   * самого `node` становится `nextType`.
   *
   * 🔴 `LEGACY-303`. `assertParentAllowed` смотрит только **вверх** и только при
   * непустом родителе, поэтому `PATCH /categories/P {"type":"category"}` на
   * корневом жанре с детьми проходил с 200: проверка не запускалась вовсе, а
   * рёбра `C(genre) → P(category)` оставались в базе. Дальше `getTree(type)`
   * отбирает термины по типу и связывает детей через `byId.has(c.parentId)`:
   * дети всплывают **корнями** в своём дереве, а `P` стоит без детей в чужом.
   *
   * Поведение выбрано решением арбитра от 29.08.2026 (`decisions-log.md`):
   * **отказ**, а не перетипизация поддерева. Путь публичного адреса строится
   * из типа термина (`getCanonicalUrl` даёт `/{lang}/genre|category|collection/...`),
   * поэтому каскад молча сменил бы адреса произвольного числа детей без
   * редиректов — это тема владельца, а не выбор реализации. Отказ повторяет
   * ту же семантику, которая уже действует на верхнем крае ребра.
   *
   * ⚠️ Читается **один** несовпадающий ребёнок, а не все дети: ответ нужен
   * двоичный, а список детей корневого термина ничем не ограничен
   * (`books/CLAUDE.md`, «Специфика проекта»). Индекс `@@index([parentId])`
   * запрос покрывает.
   *
   * ⚠️ Детям при этом не пишется ничего: ни тип, ни `parentId`. Ветка «детей
   * нет» и ветка «дети уже нужного типа» обязаны проходить — иначе запрет
   * накрыл бы и починку уже испорченного дерева (`LEGACY-263`).
   *
   * 🔴 `becomingKeys` — ключи детей, которые **в этой же партии импорта**
   * объявлены с тем же новым типом. Без них перетипизация поддерева одним
   * файлом невозможна ни в каком порядке: родитель отвергается по ребёнку
   * прежнего типа, а ребёнок — по родителю, чья запись только что
   * откатилась. Каскада это не заводит: каждый такой ребёнок назван
   * в файле явно, адреса «за кадром» не меняются. Решение арбитра
   * от 29.08.2026, строка в `decisions-log.md`.
   *
   * ⚠️ Сюда приходит голый массив ключей, а не партия импорта: об импорте
   * и его DTO дерево знать не должно. Админский `PATCH` зовёт без третьего
   * аргумента, и для него поведение прежнее.
   */
  async assertChildTypesAllowed(
    node: { id: string; type: PrismaCategory['type'] },
    db: PrismaLike = this.prisma,
    becomingKeys: string[] = [],
  ): Promise<void> {
    const mismatched = await db.category.findFirst({
      where: {
        parentId: node.id,
        type: { not: node.type },
        ...(becomingKeys.length > 0 ? { key: { notIn: becomingKeys } } : {}),
      },
      select: { id: true, key: true, type: true },
    });
    if (mismatched) {
      throw new BadRequestException(
        `Child category type mismatch: term has child "${mismatched.key}" of type ` +
          `"${mismatched.type}", which would not match the new type "${node.type}". ` +
          `Change the type of the children first, or detach them.`,
      );
    }
  }

  /**
   * 🔴 `LEGACY-315`. Разнотипные рёбра под перечисленными узлами — пачкой.
   *
   * Тот же инвариант, что стережёт `assertChildTypesAllowed`, но вопрос другой:
   * не «можно ли записать», а «что уже испорчено». Импорт пишет каждый термин
   * своей транзакцией, и проверка при записи исключает детей, которых эта же
   * партия переводит в тот же новый тип. Исключение верно, пока партия проходит
   * целиком; упавший ребёнок оставляет ребро, о котором отчёт обязан сказать.
   *
   * ⚠️ Правило «типы родителя и ребёнка совпадают» живёт в этом файле и только
   * в нём (`LEGACY-005`). Отбор идёт **условием запроса**, а не фильтром в памяти:
   * иначе `take` съедали бы согласованные дети, которых при перетипизации
   * поддерева большинство, и несовпадающий ребёнок мог не попасть в выборку вовсе.
   *
   * `expectedType` — тип, который узел должен был получить; узлы группируются
   * по нему, потому что «несовпадающий» считается относительно **своего**
   * родителя, а одним `type: { not: ... }` на всю пачку это не выражается.
   *
   * ⚠️ Тип родителя возвращается **из базы** (`parent.type`), а не берётся
   * из `expectedType`: между записью и этим запросом родителя могли перетипизировать
   * ещё раз, и вызывающий обязан сверяться с тем, что в базе сейчас. Сам
   * `expectedType` при этом остаётся условием отбора — он сужает выборку до
   * подозрительных строк, но выводом не является.
   *
   * @param take потолок строк: выборка целиком собирается в память. Вызывающий
   *   обязан заметить, что упёрся в него, и сказать об этом — «проверено не всё»
   *   не то же самое, что «всё хорошо».
   */
  async findMismatchedChildren(
    nodes: Array<{ id: string; expectedType: PrismaCategory['type'] }>,
    take: number,
    db: PrismaLike = this.prisma,
  ): Promise<{ edges: MismatchedChildEdge[]; truncated: boolean }> {
    if (nodes.length === 0) {
      return { edges: [], truncated: false };
    }

    const byType = new Map<PrismaCategory['type'], string[]>();
    for (const node of nodes) {
      const ids = byType.get(node.expectedType);
      if (ids) {
        ids.push(node.id);
      } else {
        byType.set(node.expectedType, [node.id]);
      }
    }

    // Берётся на строку больше потолка: иначе «строк ровно `take`» неотличимо
    // от «строк больше», и отчёт предупреждал бы об усечении там, где список полон.
    const rows = await db.category.findMany({
      where: {
        OR: [...byType.entries()].map(([expectedType, ids]) => ({
          parentId: { in: ids },
          type: { not: expectedType },
        })),
      },
      // ⚠️ `parentId` не выбирается намеренно. По нему было бы естественно
      // достать родителя из переданной карты — то есть взять его тип из файла
      // импорта, ровно вопреки тому, что написано выше. Ключ и тип родителя
      // берутся из `parent`, и другого пути нет.
      select: {
        key: true,
        type: true,
        parent: { select: { key: true, type: true } },
      },
      // Порядок задан явно: без него два прогона по одному и тому же испорченному
      // дереву назвали бы разные рёбра, как только выборка упрётся в потолок.
      orderBy: { key: 'asc' },
      take: take + 1,
    });

    const truncated = rows.length > take;
    // ⚠️ Второй шаг — тоже часть правила, и потому он здесь, а не у вызывающего.
    // Условие запроса отбирает по **ожидаемому** типу и лишь сужает выборку;
    // вывод «типы не совпадают» делается по типу родителя из базы. Держать эти
    // две половины в разных файлах значило бы завести второй комплект правил
    // о допустимых сочетаниях типов — ровно то, что запрещает `LEGACY-005`.
    const edges = rows
      .slice(0, take)
      .filter(
        (row): row is MismatchedChildEdge => row.parent !== null && row.type !== row.parent.type,
      );

    return { edges, truncated };
  }

  assertSameType(childType: PrismaCategory['type'], parentType: PrismaCategory['type']): void {
    if (parentType !== childType) {
      throw new BadRequestException(
        'Parent category type mismatch: parent and child must have the same type',
      );
    }
  }

  /**
   * Петля в данных — не рядовая ситуация, а испорченное дерево: обход обрывается
   * молча (иначе публичная страница отвечала бы 500 из-за чужой ошибки импорта),
   * но в логе остаётся след, по которому её можно найти и починить.
   */
  private warnCycle(startId: string, repeatedId: string): void {
    this.logger.warn(
      `Cycle detected in category hierarchy while climbing from "${startId}": ` +
        `node "${repeatedId}" visited twice. Tree is corrupted, traversal stopped.`,
    );
  }

  private warnDepth(startId: string): void {
    this.logger.warn(
      `Category hierarchy depth limit (${CATEGORY_TREE_MAX_DEPTH}) reached while climbing ` +
        `from "${startId}". Traversal stopped; the tree is either corrupted or far deeper ` +
        `than the taxonomy allows.`,
    );
  }
}

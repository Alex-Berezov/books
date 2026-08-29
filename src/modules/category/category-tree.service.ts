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
 * Подъём по дереву категорий и допустимость связи «родитель — ребёнок».
 *
 * Заведён по `LEGACY-263` и `LEGACY-264`. До него условий было два комплекта:
 * `CategoryService.update` проверял самоссылку, тип и цикл, а `ImportService`
 * не проверял ничего, кроме существования родителя, — и импорт замыкал дерево
 * там, где админский путь отвечал 400. Второй комплект правил о допустимых
 * сочетаниях типов — это `LEGACY-005`, поэтому условие живёт здесь одно.
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
  async lockTree(tx: Prisma.TransactionClient): Promise<void> {
    // ⚠️ Вызов идёт из `FROM`, а не из списка выборки: `pg_advisory_xact_lock`
    // возвращает `void`, и на `SELECT pg_advisory_xact_lock(...)` клиент падает
    // на разборе столбца этого типа. Мок такого не показывает вовсе.
    await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(${CATEGORY_TREE_LOCK_KEY})`;
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

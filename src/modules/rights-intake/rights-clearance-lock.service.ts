import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Границы транзакции под замком группы. Совпадают с `CATEGORY_TREE_TX_OPTIONS` и
 * `TAG_TX_OPTIONS` по той же причине (`L-020`): ожидание замка идёт в дедлайн транзакции,
 * и умолчание Prisma (5000/2000 мс) отдало бы `P2028` писателю, ждущему соседа, который
 * пересчитывает хеш версии по всем главам.
 */
export const CLEARANCE_TX_OPTIONS = { timeout: 30_000, maxWait: 10_000 } as const;

/**
 * Пространства имён двухаргументного `pg_advisory_xact_lock(int4, int4)`. Свои у каждого ключа:
 * `RightsProfile.id` и `RightsReview.id` — разные строки, и совпадение хешей двух разных
 * сущностей не должно ставить их в одну очередь. С `TAG_KEY_LOCK_NAMESPACE` (`831_427_002`),
 * `CATEGORY_SLUG_LOCK_NAMESPACE` (`831_427_003`), `BOOK_SUMMARY_LOCK_NAMESPACE` (`831_427_004`)
 * и `CATEGORY_TREE_LOCK_KEY` не пересекаются.
 */
const RIGHTS_PROFILE_LOCK_NAMESPACE = 831_427_101;
const RIGHTS_REVIEW_LOCK_NAMESPACE = 831_427_102;

declare const LOCKED_CLEARANCE_SCOPE: unique symbol;

/**
 * Набор версий, запертый `runInLockedClearanceScope`. Получить его иначе, чем в теле этой
 * транзакции, без приведения типа нельзя — пересчёт нескольких групп
 * (`checkStalenessForLockedScope`) мимо замка компилятор не пропустит.
 */
export type LockedClearanceScope = {
  readonly versionIds: readonly string[];
  readonly [LOCKED_CLEARANCE_SCOPE]: true;
};

const distinct = (values: Array<string | null>): string[] => [
  ...new Set(values.filter((value): value is string => value !== null)),
];

/**
 * 🔴 `LEGACY-368`, решения арбитра от 16.09.2026 (`decisions-log.md`).
 *
 * Пометка stale (`RightsContentHashService.markVersionAndClearanceStale`) внутри транзакции
 * вызывающего пишет свою строку `BookVersion`, а потом строки соседних версий того же профиля
 * прав и той же проверки прав. Две такие транзакции на разных версиях одной группы брали строки
 * крест-накрест, и PostgreSQL отвечал 40P01. Замок группы ставит их в очередь до первой записи;
 * транзакции с непересекающимися ключами расходятся без цикла, потому что общих чужих версий
 * фан-аут касается одним списком, отсортированным по `id`.
 *
 * Правила держит конструкция, а не комментарий у места вызова (`LEGACY-310`):
 * - транзакцию открывает `runInLockedClearance`, и замок — её **первый** оператор; строка
 *   версии, тронутая до замка, возвращает цикл (`book-version.update` пишет версию раньше пометки);
 * - ключей два и порядок один: сначала профиль, потом проверка прав;
 * - поле со значением `null` пропускается: такой группы нет, соседей по ней фан-аут не ищет.
 *
 * ⚠️ Через `runInLockedClearance` идут 11 писателей одной версии: `ChapterService` (3),
 * `AudioChapterService` (4), `BookVersionService` (`update` и три ручки участников).
 * Пересчёт по персоне и профилю (`PersonsService.update`, `ContributorsService`) идёт через
 * `runInLockedClearanceScope` (`LEGACY-368`, T33). Порядок замков групп у обоих путей один —
 * `lockGroups`. Ручная проверка хеша (`checkVersionStaleness` без `tx`) в транзакции `markSelf`
 * остаётся без замка. Ключи групп читаются до замка: версия, переведённая на другую группу
 * в этом окне, пишется под старыми ключами. Нового писателя с `tx` в пометку
 * компилятор мимо обёртки пропустит — «дедлок закрыт целиком» писать нельзя (`L-019`).
 */
@Injectable()
export class RightsClearanceLockService {
  constructor(private readonly prisma: PrismaService) {}

  async runInLockedClearance<T>(
    versionId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockVersionClearance(tx, versionId);
      return fn(tx);
    }, CLEARANCE_TX_OPTIONS);
  }

  private async lockVersionClearance(
    tx: Prisma.TransactionClient,
    versionId: string,
  ): Promise<void> {
    const version = await tx.bookVersion.findUnique({
      where: { id: versionId },
      select: { rightsProfileId: true, approvedRightsReviewId: true },
    });
    if (!version) return;

    await this.lockGroups(
      tx,
      distinct([version.rightsProfileId]),
      distinct([version.approvedRightsReviewId]),
    );
  }

  /**
   * Транзакция пересчёта, который помечает версии **нескольких** групп (`LEGACY-368`, T33):
   * пересчёт по персоне, привязка и отвязка участника профиля. Открывает транзакцию сама и
   * первым делом запирает набор версий, который вернул `resolveVersionIds`, — тело получает `tx` и запертый набор, записать что-то до замка ему нечем. Пустой набор ничего
   * не запирает, тело идёт как обычная транзакция.
   */
  async runInLockedClearanceScope<T>(
    resolveVersionIds: (tx: Prisma.TransactionClient) => Promise<readonly string[]>,
    fn: (tx: Prisma.TransactionClient, scope: LockedClearanceScope) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const scope = await this.lockClearanceScope(tx, await resolveVersionIds(tx));
      return fn(tx, scope);
    }, CLEARANCE_TX_OPTIONS);
  }

  /**
   * Одного замка групп здесь мало: пометка идёт по версии за раз, и фан-ауты разных версий трогают
   * чужие версии не одним отсортированным списком — со встречным писателем непересекающейся группы
   * это цикл через общих соседей. Поэтому после замков групп строки всех версий, которые пересчёт
   * может тронуть (сами версии и все версии их групп), берутся `FOR NO KEY UPDATE` одним запросом
   * по возрастанию `id` — тем же порядком, что и у фан-аута (в плане `LockRows` стоит над `Sort`).
   *
   * Замки групп — `lockGroups`, тот же, что у `lockVersionClearance`.
   *
   * Пересчёт идёт ровно по возвращённому набору (`checkStalenessForLockedScope`): перечитанный
   * заново набор мог бы включить версию, связанную чужой транзакцией уже после замка.
   */
  private async lockClearanceScope(
    tx: Prisma.TransactionClient,
    versionIds: readonly string[],
  ): Promise<LockedClearanceScope> {
    const ids = [...new Set(versionIds)];
    if (ids.length === 0) return { versionIds: [] } as unknown as LockedClearanceScope;

    const versions = await tx.bookVersion.findMany({
      where: { id: { in: ids } },
      select: { rightsProfileId: true, approvedRightsReviewId: true },
    });
    const profileIds = distinct(versions.map((v) => v.rightsProfileId));
    const reviewIds = distinct(versions.map((v) => v.approvedRightsReviewId));

    await this.lockGroups(tx, profileIds, reviewIds);

    await tx.$queryRaw`SELECT id FROM "BookVersion"
      WHERE id = ANY(${ids}::text[])
        OR "rightsProfileId" = ANY(${profileIds}::text[])
        OR "approvedRightsReviewId" = ANY(${reviewIds}::text[])
      ORDER BY id
      FOR NO KEY UPDATE`;

    return { versionIds: ids } as unknown as LockedClearanceScope;
  }

  /**
   * Единственное место, где задан порядок замков групп (`LEGACY-368`): все профили, потом все
   * проверки прав. Один путь с другим порядком вернул бы цикл со всеми остальными.
   */
  private async lockGroups(
    tx: Prisma.TransactionClient,
    profileIds: string[],
    reviewIds: string[],
  ): Promise<void> {
    await this.lockKeys(tx, RIGHTS_PROFILE_LOCK_NAMESPACE, profileIds);
    await this.lockKeys(tx, RIGHTS_REVIEW_LOCK_NAMESPACE, reviewIds);
  }

  /**
   * Ключи вида — по возрастанию самого ключа замка (`hashtext`), а не строки id: совпадение хешей
   * двух id иначе поставило бы один ключ в разные места порядка. Один ключ — без лишнего запроса.
   */
  private async lockKeys(
    tx: Prisma.TransactionClient,
    namespace: number,
    ids: string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    if (ids.length === 1) {
      await this.lock(tx, namespace, ids[0]);
      return;
    }
    const keys = await tx.$queryRaw<Array<{ key: number }>>`SELECT DISTINCT hashtext(lock_id) AS key
      FROM unnest(${ids}::text[]) AS lock_id
      ORDER BY key`;
    for (const { key } of keys) {
      await tx.$queryRaw`SELECT true AS locked
        FROM pg_advisory_xact_lock(${namespace}::int4, ${key}::int4)`;
    }
  }

  // Вызов из `FROM`: `pg_advisory_xact_lock` возвращает `void` (см. `CategoryTreeService.lockTree`).
  private async lock(tx: Prisma.TransactionClient, namespace: number, id: string): Promise<void> {
    await tx.$queryRaw`SELECT true AS locked
      FROM pg_advisory_xact_lock(${namespace}::int4, hashtext(${id}::text))`;
  }
}

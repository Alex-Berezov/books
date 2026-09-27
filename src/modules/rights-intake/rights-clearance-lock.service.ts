import { ConflictException, Injectable } from '@nestjs/common';
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
export const RIGHTS_PROFILE_LOCK_NAMESPACE = 831_427_101;
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

/**
 * Попыток на одну транзакцию под замком (`LEGACY-368`, решение арбитра 27.09.2026): версия,
 * переведённая в другую группу между чтением ключей и замком, откатывает попытку до вызова тела.
 * Три подряд — это поток перепривязок, а не гонка, и отвечать надо 409, а не крутить очередь.
 */
export const CLEARANCE_GROUP_ATTEMPTS = 3;

export const CLEARANCE_GROUP_MOVED_CODE = 'RIGHTS_CLEARANCE_GROUP_MOVED';

/** Ключи группы под замком строки разошлись с прочитанными до замка — попытка откатывается. */
class ClearanceGroupMovedError extends Error {}

type GroupKeys = { rightsProfileId: string | null; approvedRightsReviewId: string | null };

type VersionKeys = GroupKeys & { id: string };

const isSameGroup = (a: GroupKeys, b: GroupKeys): boolean =>
  a.rightsProfileId === b.rightsProfileId && a.approvedRightsReviewId === b.approvedRightsReviewId;

/**
 * Одна сверка на оба пути: ключи каждой версии, прочитанные до замка, против её строки под
 * замком. Версии, которой под замком нет (удалена встречной транзакцией), сверять не с чем —
 * тело увидит её отсутствие само, как и до T56.
 */
const assertGroupsUnchanged = (before: VersionKeys[], underLock: VersionKeys[]): void => {
  const lockedById = new Map(underLock.map((row) => [row.id, row]));
  for (const version of before) {
    const now = lockedById.get(version.id);
    if (now && !isSameGroup(now, version)) throw new ClearanceGroupMovedError();
  }
};

const distinct = (values: Array<string | null>): string[] => [
  ...new Set(values.filter((value): value is string => value !== null)),
];

/**
 * 🔴 `LEGACY-368`, решения арбитра от 16.09.2026 (`decisions-log.md`).
 *
 * Пометка stale (прежний `RightsContentHashService.markVersionAndClearanceStale`, снят решением
 * владельца от 27.09.2026 вместе с фан-аутом) внутри транзакции вызывающего писала свою строку
 * `BookVersion`, а потом строки соседних версий того же профиля прав и той же проверки прав. Две такие транзакции на разных версиях одной группы брали строки
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
 * ⚠️ Через `runInLockedClearance` идут 11 писателей одной версии со своим `tx`: `ChapterService` (3),
 * `AudioChapterService` (4), `BookVersionService` (`update` и три ручки участников).
 * Пересчёт по персоне и профилю (`PersonsService.update`, `ContributorsService`) идёт через
 * `runInLockedClearanceScope` (`LEGACY-368`, T33). Порядок замков групп у обоих путей один —
 * `lockGroups`. Путь без `tx` (ручная проверка хеша, файл источника) замок больше не берёт:
 * после решения владельца от 27.09.2026 он пишет одну строку версии и событие, без фан-аута
 * (прежде — T56). Ключи групп читаются до замка и сверяются после
 * него под замком строки версии: версия, переведённая в другую группу в этом окне, откатывает
 * попытку (`ClearanceGroupMovedError`), и транзакция начинается заново. Набор версий персоны
 * (`resolveVersionIds`) так не сверяется — окно принято (тело `LEGACY-368`). Нового писателя
 * с `tx` в пометку компилятор мимо обёртки пропустит. Сторож `clearance-lock-writers.spec.ts`
 * ловит только вызов двух методов пересчёта с `tx` текстом вне колбэка замка: чей это `tx`, он
 * не сверяет, а новый метод самого сервиса хеша, пробрасывающий `tx`, не видит вовсе.
 * «Дедлок закрыт целиком» писать нельзя (`L-019`).
 */
@Injectable()
export class RightsClearanceLockService {
  constructor(private readonly prisma: PrismaService) {}

  async runInLockedClearance<T>(
    versionId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.inLockedTransaction(
      (tx) => this.lockVersionClearance(tx, versionId),
      (tx) => fn(tx),
    );
  }

  /**
   * Ключи, прочитанные до замка, сверяются с ключами под замком строки: `FOR NO KEY UPDATE`
   * после замка групп не даёт перепривязке (`rights-book-creation`) вклиниться между сверкой
   * и телом, а уже закоммиченную перепривязку показывает расхождением.
   */
  private async lockVersionClearance(
    tx: Prisma.TransactionClient,
    versionId: string,
  ): Promise<void> {
    const version = await tx.bookVersion.findUnique({
      where: { id: versionId },
      select: { id: true, rightsProfileId: true, approvedRightsReviewId: true },
    });
    if (!version) return;

    await this.lockGroups(
      tx,
      distinct([version.rightsProfileId]),
      distinct([version.approvedRightsReviewId]),
    );

    const locked = await tx.$queryRaw<
      VersionKeys[]
    >`SELECT id, "rightsProfileId", "approvedRightsReviewId"
      FROM "BookVersion"
      WHERE id = ${versionId}
      FOR NO KEY UPDATE`;
    assertGroupsUnchanged([version], locked);
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
    return this.inLockedTransaction(
      async (tx) => this.lockClearanceScope(tx, await resolveVersionIds(tx)),
      fn,
    );
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
   * Ключи версий набора берутся из того же запроса строк и сверяются с прочитанными до замка
   * (решение арбитра 27.09.2026) — расхождение откатывает попытку, как у `lockVersionClearance`.
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
      select: { id: true, rightsProfileId: true, approvedRightsReviewId: true },
    });
    const profileIds = distinct(versions.map((v) => v.rightsProfileId));
    const reviewIds = distinct(versions.map((v) => v.approvedRightsReviewId));

    await this.lockGroups(tx, profileIds, reviewIds);

    const locked = await tx.$queryRaw<
      VersionKeys[]
    >`SELECT id, "rightsProfileId", "approvedRightsReviewId"
      FROM "BookVersion"
      WHERE id = ANY(${ids}::text[])
        OR "rightsProfileId" = ANY(${profileIds}::text[])
        OR "approvedRightsReviewId" = ANY(${reviewIds}::text[])
      ORDER BY id
      FOR NO KEY UPDATE`;
    assertGroupsUnchanged(versions, locked);

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

  /**
   * Одна транзакция под замком на оба входа. Повтор только до вызова тела: расхождение ключей
   * бросает `lock`, и тогда транзакция откатывается целиком и начинается заново; после входа
   * в тело ошибка уходит наверх как есть. Исчерпали попытки — 409.
   */
  private async inLockedTransaction<S, T>(
    lock: (tx: Prisma.TransactionClient) => Promise<S>,
    fn: (tx: Prisma.TransactionClient, locked: S) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      let hasBodyStarted = false;
      try {
        return await this.prisma.$transaction(async (tx) => {
          const locked = await lock(tx);
          hasBodyStarted = true;
          return fn(tx, locked);
        }, CLEARANCE_TX_OPTIONS);
      } catch (error) {
        if (hasBodyStarted || !(error instanceof ClearanceGroupMovedError)) throw error;
        if (attempt >= CLEARANCE_GROUP_ATTEMPTS) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: CLEARANCE_GROUP_MOVED_CODE,
            message: 'Rights clearance group of the version changed concurrently',
          });
        }
      }
    }
  }
}

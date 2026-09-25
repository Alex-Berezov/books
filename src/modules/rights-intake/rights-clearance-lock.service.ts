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
 * ⚠️ Через обёртку идут 11 писателей: `ChapterService` (3), `AudioChapterService` (4),
 * `BookVersionService` (`update` и три ручки участников). Без замка пишут строки версий группы:
 * пересчёт по персоне и профилю (`PersonsService.update`, `ContributorsService`) в своей
 * транзакции и ручная проверка хеша (`checkVersionStaleness` без `tx`) в транзакции `markSelf`;
 * ключи здесь читаются без `FOR UPDATE`. Нового писателя с `tx` в пометку компилятор мимо
 * обёртки пропустит — «дедлок закрыт целиком» писать нельзя (`L-019`, тело `LEGACY-368`).
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

    if (version.rightsProfileId) {
      await this.lock(tx, RIGHTS_PROFILE_LOCK_NAMESPACE, version.rightsProfileId);
    }
    if (version.approvedRightsReviewId) {
      await this.lock(tx, RIGHTS_REVIEW_LOCK_NAMESPACE, version.approvedRightsReviewId);
    }
  }

  // Вызов из `FROM`: `pg_advisory_xact_lock` возвращает `void` (см. `CategoryTreeService.lockTree`).
  private async lock(tx: Prisma.TransactionClient, namespace: number, id: string): Promise<void> {
    await tx.$queryRaw`SELECT true AS locked
      FROM pg_advisory_xact_lock(${namespace}::int4, hashtext(${id}::text))`;
  }
}

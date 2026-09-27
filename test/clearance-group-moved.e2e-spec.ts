import { Test, TestingModule } from '@nestjs/testing';
import { BookType, Language, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  RIGHTS_PROFILE_LOCK_NAMESPACE,
  RightsClearanceLockService,
} from '../src/modules/rights-intake/rights-clearance-lock.service';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';

/**
 * 🔴 `LEGACY-368`, T56 (решение арбитра 27.09.2026). Замок клиренса читал ключи группы версии
 * до `pg_advisory_xact_lock` и после него их не сверял: версия, переведённая в другую группу,
 * пока писатель ждал замка, писалась под замком старой группы — встречный писатель новой группы
 * шёл параллельно, и цикл 40P01 возвращался.
 *
 * ⚠️ Юнит этого не воспроизводит: поддельный `$transaction` не ждёт замка. Здесь ожидание
 * настоящее — первый писатель держит группу продуктовой точкой входа, второй встаёт в очередь
 * уже с прочитанными ключами, перепривязка коммитится между ними. Проверяется, какой
 * advisory-замок второй писатель держит к моменту, когда получил тело.
 */
describe('LEGACY-368 — перепривязка версии между чтением ключей и замком (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let clearanceLock: RightsClearanceLockService;

  const stamp = Date.now();
  const slugA = `clr-moved-a-${stamp}`;
  const slugB = `clr-moved-b-${stamp}`;
  let groupA: { profileId: string; reviewId: string };
  let groupB: { profileId: string; reviewId: string };
  let bookAId: string;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // Сервисы достаются до `init()` — порядок и причина те же, что в `tag-row-lock.e2e-spec.ts`.
  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    clearanceLock = moduleRef.get(RightsClearanceLockService);
    await moduleRef.init();

    const a = await createBookWithRights(prisma as unknown as PrismaClient, slugA);
    const b = await createBookWithRights(prisma as unknown as PrismaClient, slugB);
    groupA = { profileId: a.profile.id, reviewId: a.review.id };
    groupB = { profileId: b.profile.id, reviewId: b.review.id };
    bookAId = a.book.id;
  });

  afterAll(async () => {
    try {
      await cleanupBookWithRights(prisma as unknown as PrismaClient, slugA);
      await cleanupBookWithRights(prisma as unknown as PrismaClient, slugB);
    } finally {
      await moduleRef?.close();
    }
  });

  const makeVersion = (language: Language) =>
    prisma.bookVersion.create({
      data: {
        bookId: bookAId,
        language,
        title: `${slugA}-${language}`,
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/c.jpg',
        type: BookType.text,
        isFree: true,
        status: 'draft',
        rightsProfileId: groupA.profileId,
        approvedRightsReviewId: groupA.reviewId,
      },
    });

  /** Держит ли текущее соединение advisory-замок профиля `profileId` (пространство профилей). */
  const holdsProfileLock = async (
    tx: Parameters<Parameters<RightsClearanceLockService['runInLockedClearance']>[1]>[0],
    profileId: string,
  ): Promise<boolean> => {
    const [row] = await tx.$queryRaw<Array<{ held: boolean }>>`SELECT EXISTS (
        SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND objsubid = 2
          AND classid::bigint = ${RIGHTS_PROFILE_LOCK_NAMESPACE}
          AND objid::bigint = (hashtext(${profileId}::text)::bigint & 4294967295)
      ) AS held`;
    return row.held;
  };

  /**
   * Сценарий один на оба пути: первый писатель держит группу A через соседнюю версию,
   * второй встаёт в очередь за версией `moved`, перепривязка `moved` в группу B коммитится,
   * первый отпускает. Возвращает, какую группу второй держал в теле, и сколько транзакций он
   * открыл: две — значит, первая попытка увидела расхождение и откатилась, а не гонки не было.
   */
  const raceRebind = async (
    moved: string,
    neighbour: string,
    enter: (fn: (tx: Parameters<typeof holdsProfileLock>[0]) => Promise<void>) => Promise<void>,
  ) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = clearanceLock.runInLockedClearance(neighbour, () => held);
    await sleep(300);

    const transactions = jest.spyOn(prisma, '$transaction');
    const openedBefore = transactions.mock.calls.length;
    const seen: Array<{ holdsA: boolean; holdsB: boolean; profileId: string | null }> = [];
    const waiter = enter(async (tx) => {
      const row = await tx.bookVersion.findUnique({
        where: { id: moved },
        select: { rightsProfileId: true },
      });
      seen.push({
        holdsA: await holdsProfileLock(tx, groupA.profileId),
        holdsB: await holdsProfileLock(tx, groupB.profileId),
        profileId: row?.rightsProfileId ?? null,
      });
    });
    await sleep(300);

    await prisma.bookVersion.update({
      where: { id: moved },
      data: { rightsProfileId: groupB.profileId, approvedRightsReviewId: groupB.reviewId },
    });

    release();
    await holder;
    await waiter;
    const attempts = transactions.mock.calls.length - openedBefore;
    transactions.mockRestore();
    return { seen, attempts };
  };

  it('путь одной версии: повтор, тело держит замок новой группы', async () => {
    const moved = await makeVersion(Language.en);
    const neighbour = await makeVersion(Language.es);

    const { seen, attempts } = await raceRebind(moved.id, neighbour.id, (fn) =>
      clearanceLock.runInLockedClearance(moved.id, fn),
    );

    expect(seen).toEqual([{ holdsA: false, holdsB: true, profileId: groupB.profileId }]);
    expect(attempts).toBe(2);
  });

  it('путь набора: повтор, тело держит замок новой группы', async () => {
    const moved = await makeVersion(Language.fr);
    const neighbour = await makeVersion(Language.pt);

    const { seen, attempts } = await raceRebind(moved.id, neighbour.id, (fn) =>
      clearanceLock.runInLockedClearanceScope(
        () => Promise.resolve([moved.id]),
        (tx) => fn(tx),
      ),
    );

    expect(seen).toEqual([{ holdsA: false, holdsB: true, profileId: groupB.profileId }]);
    expect(attempts).toBe(2);
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { BookType, Language, Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { BookVersionService } from '../src/modules/book-version/book-version.service';
import { RightsContentHashService } from '../src/modules/rights-intake/rights-content-hash.service';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';

/**
 * `LEGACY-400`, пачка `T80` (решение арбитра 01.10.2026). `BookVersionService.update` берёт строку версии
 * `FOR NO KEY UPDATE` (замок клиренса, `runInLockedClearance`) и **не** добавляет к нему `FOR UPDATE`
 * при полях SEO. Подъём до `FOR UPDATE` делает сам UPDATE и только когда меняется уникальная колонка:
 * `slug` или `seoId` при первом создании `Seo`. Правка уже существующего `Seo` оставляет `seoId`
 * прежним и замок не поднимает.
 *
 * Проба держит **настоящую** транзакцию `update` после её UPDATE (в `checkVersionStaleness`) и пускает
 * навстречу то, что берёт FK-вставка главы, — `SELECT … FOR KEY SHARE` по той же строке. Встал ли он
 * в очередь, видно по `pg_blocking_pids` против соединения держателя. Стенд юнит-спеки с
 * `createClearanceLockFake` замка клиренса не берёт и о подъёме ничего бы не сказал (`L-004`).
 *
 * Окно 40P01 на этом подъёме принято, а не закрыто (остаток `LEGACY-400`): проба фиксирует,
 * где подъём есть и где его нет, а не обещает отсутствие дедлока.
 */
describe('LEGACY-400 — замок строки версии в update при записи Seo (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let versions: BookVersionService;
  let hash: RightsContentHashService;

  const stamp = Date.now();
  const slugs: string[] = [];
  const seoIds: number[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    versions = moduleRef.get(BookVersionService);
    hash = moduleRef.get(RightsContentHashService);
    await moduleRef.init();
  });

  afterAll(async () => {
    try {
      for (const slug of slugs) {
        await cleanupBookWithRights(prisma as unknown as PrismaClient, slug);
      }
      await prisma.seo.deleteMany({ where: { id: { in: seoIds } } });
    } finally {
      await moduleRef?.close();
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const makeVersion = async (withSeo: boolean) => {
    const slug = `t80-lock-${stamp}-${slugs.length}`;
    slugs.push(slug);
    const fx = await createBookWithRights(prisma as unknown as PrismaClient, slug);
    let seoId: number | undefined;
    if (withSeo) {
      const seo = await prisma.seo.create({ data: { metaTitle: `${slug} before` } });
      seoIds.push(seo.id);
      seoId = seo.id;
    }
    const version = await prisma.bookVersion.create({
      data: {
        bookId: fx.book.id,
        language: Language.en,
        slug: `${slug}-en`,
        title: slug,
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/c.jpg',
        type: BookType.text,
        isFree: true,
        status: 'draft',
        rightsProfileId: fx.profile.id,
        approvedRightsReviewId: fx.review.id,
        ...(seoId ? { seoId } : {}),
      },
    });
    return version.id;
  };

  const backendPid = async (tx: Prisma.TransactionClient): Promise<number> => {
    const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    return row.pid;
  };

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /** Ждёт, пока кто-то встанет в очередь именно за соединением `holderPid`. */
  const waitBlockedBy = async (holderPid: number, deadlineMs: number): Promise<boolean> => {
    const until = Date.now() + deadlineMs;
    while (Date.now() < until) {
      const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
      if (row.n > 0) return true;
      await sleep(50);
    }
    return false;
  };

  /**
   * Держит `update` после его UPDATE и пускает навстречу `FOR KEY SHARE` по той же строке.
   * `blocked` — встал ли встречный запрос за держателем; без подъёма он проходит сразу.
   */
  const probe = async (id: string, dto: Parameters<BookVersionService['update']>[1]) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: (pid: number) => void = () => undefined;
    const inside = new Promise<number>((resolve) => {
      entered = resolve;
    });
    const real = hash.checkVersionStaleness.bind(
      hash,
    ) as RightsContentHashService['checkVersionStaleness'];
    jest
      .spyOn(hash, 'checkVersionStaleness')
      .mockImplementationOnce(async (...args: Parameters<typeof real>) => {
        entered(await backendPid(args[4] as Prisma.TransactionClient));
        await held;
        return real(...args);
      });

    const writer = versions.update(id, dto);
    let counter: Promise<unknown> = Promise.resolve();
    let blocked = false;
    try {
      const holderPid = await Promise.race([
        inside,
        writer.then(() => {
          throw new Error('update закончился, не дойдя до точки удержания');
        }),
      ]);
      counter = prisma.$queryRaw`SELECT id FROM "BookVersion" WHERE id = ${id} FOR KEY SHARE`;
      const passedAtOnce = await Promise.race([
        counter.then(() => true),
        sleep(2_000).then(() => false),
      ]);
      blocked = passedAtOnce ? false : await waitBlockedBy(holderPid, 10_000);
    } catch (error) {
      release();
      await Promise.allSettled([writer, counter]);
      throw error;
    } finally {
      release();
    }
    const [w, c] = await Promise.allSettled([writer, counter]);
    return { blocked, writer: w, counter: c };
  };

  it('контроль: смена слага поднимает замок — встречный FOR KEY SHARE ждёт', async () => {
    const id = await makeVersion(false);

    const result = await probe(id, { slug: `t80-lock-moved-${stamp}` });

    expect(result.blocked).toBe(true);
    expect(result.writer.status).toBe('fulfilled');
    expect(result.counter.status).toBe('fulfilled');
  }, 60_000);

  it('первое создание Seo меняет seoId — замок поднимается, встречный FOR KEY SHARE ждёт', async () => {
    const id = await makeVersion(false);

    const result = await probe(id, { title: 'T2', seoMetaTitle: 'MT' });

    expect(result.blocked).toBe(true);
    expect(result.writer.status).toBe('fulfilled');
    expect(result.counter.status).toBe('fulfilled');
    const after = await prisma.bookVersion.findUnique({ where: { id }, select: { seoId: true } });
    expect(after?.seoId).not.toBeNull();
    if (after?.seoId) seoIds.push(after.seoId);
  }, 60_000);

  it('правка существующего Seo оставляет seoId прежним — замок не поднимается', async () => {
    const id = await makeVersion(true);

    const result = await probe(id, { title: 'T2', seoMetaTitle: 'MT after' });

    expect(result.blocked).toBe(false);
    expect(result.writer.status).toBe('fulfilled');
    expect(result.counter.status).toBe('fulfilled');
  }, 60_000);

  it('правка без полей SEO — замок не поднимается', async () => {
    const id = await makeVersion(false);

    const result = await probe(id, { title: 'T2' });

    expect(result.blocked).toBe(false);
    expect(result.writer.status).toBe('fulfilled');
    expect(result.counter.status).toBe('fulfilled');
  }, 60_000);
});

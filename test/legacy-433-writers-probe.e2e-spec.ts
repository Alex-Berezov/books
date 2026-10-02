import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { BookType, CategoryType, Language, Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { CategoryService } from '../src/modules/category/category.service';
import { CommentsService } from '../src/modules/comments/comments.service';
import { TagsService } from '../src/modules/tags/tags.service';
import { UsersService } from '../src/modules/users/users.service';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';
import { backendPid, waitBlockedBy } from './helpers/lock-probe';

/**
 * 🔴 `LEGACY-433` / `LEGACY-434`, пачка `T83`. Живая проба писателей, которых нет под замком группы
 * (`runInLockedClearance`), против каскада удаления версии и книги.
 *
 * Привязка тега и категории: проверка внешнего ключа ставит `FOR KEY SHARE` на строки версий
 * в порядке вставки, а `BookService.remove` запирает их `ORDER BY id FOR UPDATE`
 * (`lockLicenseSnapshotsByBook`). Держатель стенда берёт строки так же — по возрастанию `id`, —
 * и пока он держит первую, писатель, у которого сёстры пошли бы в обратном порядке, успевает
 * взять вторую и ждёт первую: встречная попытка держателя взять вторую — `40P01`. Порядок сестёр
 * у писателя подменён обратным: от сортировки по `id` в сервисе зависит, цикл это или очередь.
 * Проба на отказ: без `orderBy: { id: 'asc' }` в `attach` тег и категория дают `40P01`.
 *
 * Корневой комментарий: цель, удалённая встречной транзакцией, — 404, а не `P2003` и 500.
 * Ответ против удаления аккаунта автора корня — без замка (решение арбитра 02.10.2026,
 * `decisions-log.md`): ответ, записанный до удаления, становится корневым отзывом, как и прежде
 * (`ON DELETE SET NULL`); ответ после удаления — 404.
 */
describe('LEGACY-433/434 — писатели вне замка группы против каскада удаления (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let tags: TagsService;
  let categories: CategoryService;
  let comments: CommentsService;
  let users: UsersService;

  const stamp = Date.now();
  const slugs: string[] = [];
  const tagIds: string[] = [];
  const categoryIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    tags = moduleRef.get(TagsService);
    categories = moduleRef.get(CategoryService);
    comments = moduleRef.get(CommentsService);
    users = moduleRef.get(UsersService);
    await moduleRef.init();
  });

  afterAll(async () => {
    try {
      await prisma.comment.deleteMany({ where: { userId: { in: userIds } } });
      for (const slug of slugs) {
        await cleanupBookWithRights(prisma as unknown as PrismaClient, slug);
      }
      await prisma.tag.deleteMany({ where: { id: { in: tagIds } } });
      await prisma.category.deleteMany({ where: { id: { in: categoryIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await moduleRef?.close();
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const makeBook = async () => {
    const slug = `t83-${stamp}-${slugs.length}`;
    slugs.push(slug);
    const fx = await createBookWithRights(prisma as unknown as PrismaClient, slug);
    const makeVersion = (language: Language) =>
      prisma.bookVersion.create({
        data: {
          bookId: fx.book.id,
          language,
          slug: `${slug}-${language}`,
          title: `${slug}-${language}`,
          author: 'A',
          description: 'D',
          coverImageUrl: 'https://example.com/c.jpg',
          type: BookType.text,
          isFree: true,
          status: 'draft',
          rightsProfileId: fx.profile.id,
          approvedRightsReviewId: fx.review.id,
        },
      });
    const first = await makeVersion(Language.en);
    const second = await makeVersion(Language.es);
    const [low, high] = [first.id, second.id].sort();
    return { bookId: fx.book.id, low, high };
  };

  const makeUser = async (tag: string) => {
    const user = await prisma.user.create({
      data: {
        email: `t83-${tag}-${stamp}-${userIds.length}@ex.com`,
        languagePreference: Language.en,
      },
    });
    userIds.push(user.id);
    return user.id;
  };

  const lockVersion = (tx: Prisma.TransactionClient, id: string) =>
    tx.$queryRaw`SELECT id FROM "BookVersion" WHERE id = ${id} FOR UPDATE`;

  /**
   * Держатель стенда: транзакция берёт строки `lockFirst` и держит их, пока `body` не вернётся.
   * `body(pid, tx)` запускает писателя, ждёт его в очереди и возвращает то, что держатель делает дальше.
   */
  const withHolder = async <T>(
    lockFirst: (tx: Prisma.TransactionClient) => Promise<unknown>,
    body: (holderPid: number, tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> =>
    prisma.$transaction(
      async (tx) => {
        await lockFirst(tx);
        return body(await backendPid(tx), tx);
      },
      { timeout: 30_000, maxWait: 10_000 },
    );

  const settle = async (op: Promise<unknown>) => (await Promise.allSettled([op]))[0];
  const text = (result: PromiseSettledResult<unknown>) =>
    result.status === 'fulfilled'
      ? ''
      : `${(result.reason as { code?: string }).code ?? ''} ${String((result.reason as Error).message)}`;

  /**
   * Сёстры в порядке, как отдала бы база **без** `ORDER BY`: сначала старшая по `id`. Запрос с
   * `orderBy` идёт как есть — тогда порядок задан кодом сервиса, а не стендом.
   */
  const reversedSiblings = (highFirst: string[]) => {
    const real = prisma.bookVersion.findMany.bind(prisma.bookVersion) as (args: {
      orderBy?: unknown;
    }) => Promise<Array<{ id: string }>>;
    jest
      .spyOn(prisma.bookVersion, 'findMany')
      .mockImplementationOnce(((args: { orderBy?: unknown }) =>
        real(args).then((rows) =>
          args.orderBy
            ? rows
            : [...rows].sort((a, b) => highFirst.indexOf(a.id) - highFirst.indexOf(b.id)),
        )) as never);
  };

  describe.each([
    [
      'привязка тега',
      async (versionId: string) => {
        const tag = await prisma.tag.create({
          data: { name: 't83', slug: `t83-${stamp}`, key: `t83-${stamp}-${tagIds.length}` },
        });
        tagIds.push(tag.id);
        return () => tags.attach(versionId, tag.id);
      },
    ],
    [
      'привязка категории',
      async (versionId: string) => {
        const category = await prisma.category.create({
          data: {
            type: CategoryType.genre,
            name: 't83',
            slug: `t83-${stamp}`,
            key: `t83-${stamp}-${categoryIds.length}`,
          },
        });
        categoryIds.push(category.id);
        return () => categories.attachCategoryToVersion(versionId, category.id);
      },
    ],
  ])('%s против удаления книги', (_name, prepare) => {
    it('держатель берёт версии по возрастанию id — писатель встаёт в очередь, цикла нет', async () => {
      const f = await makeBook();
      const attach = await prepare(f.low);
      reversedSiblings([f.high, f.low]);

      const outcome = await withHolder(
        (tx) => lockVersion(tx, f.low),
        async (holderPid, tx) => {
          const writer = settle(attach());
          const blocked = await waitBlockedBy(prisma, holderPid);
          // Дальше держатель берёт вторую версию, как `lockLicenseSnapshotsByBook`, и отпускает обе.
          await lockVersion(tx, f.high);
          return { blocked, writer };
        },
      );

      expect(outcome.blocked).toBe(true);
      expect(text(await outcome.writer)).toBe('');
    });
  });

  describe('корневой комментарий против удаления цели (LEGACY-434)', () => {
    it('цель удалена встречной транзакцией — 404, а не P2003 и 500', async () => {
      const f = await makeBook();
      const author = await makeUser('author');

      const held = await withHolder(
        (tx) => lockVersion(tx, f.low),
        async (holderPid, tx) => {
          const op = settle(
            comments.create(author, { bookVersionId: f.low, text: 'root' } as never),
          );
          // Проверка существования цели идёт на пуле и видит версию; ждёт писатель уже в транзакции.
          expect(await waitBlockedBy(prisma, holderPid)).toBe(true);
          await tx.comment.deleteMany({ where: { bookVersionId: f.low } });
          await tx.bookVersion.delete({ where: { id: f.low } });
          return { op };
        },
      );

      // Держатель закоммитился, и только теперь писатель получает ответ.
      const writer = await held.op;
      expect(writer.status).toBe('rejected');
      expect((writer as PromiseRejectedResult).reason).toBeInstanceOf(NotFoundException);
      expect(await prisma.comment.count({ where: { text: 'root', userId: author } })).toBe(0);
    });
  });

  describe('комментарий против удаления аккаунта автора (LEGACY-434)', () => {
    it('аккаунт удалён встречной транзакцией — 404 «User not found», а не P2003 и 500', async () => {
      const f = await makeBook();
      const author = await makeUser('gone');

      const held = await withHolder(
        // Как `deleteById`: строка пользователя `FOR UPDATE` первым оператором.
        (tx) => tx.$queryRaw`SELECT id FROM "User" WHERE id = ${author} FOR UPDATE`,
        async (holderPid, tx) => {
          const op = settle(
            comments.create(author, { bookVersionId: f.low, text: 'orphan' } as never),
          );
          const blocked = await waitBlockedBy(prisma, holderPid);
          await tx.user.delete({ where: { id: author } });
          return { op, blocked };
        },
      );
      userIds.splice(userIds.indexOf(author), 1);

      expect(held.blocked).toBe(true);
      const writer = await held.op;
      expect(writer.status).toBe('rejected');
      expect(text(writer)).toMatch(/User not found/);
    });
  });

  describe('отзыв с первой оценкой против удаления книги (LEGACY-433)', () => {
    /**
     * Держатель запирает как `BookService.remove`: строку книги `FOR UPDATE`, потом версии
     * `ORDER BY id FOR UPDATE`. Отзыв с оценкой вставляет `BookRating` — внешний ключ на книгу.
     * Запри отзыв версию раньше книги — держатель встал бы за ним на версии, а отзыв за держателем
     * на книге: `40P01`. Проба на отказ: без замка книги в `lockTargets` отзыв ловит `deadlock`.
     */
    it('отзыв встаёт за удалением на строке книги — цикла нет', async () => {
      const f = await makeBook();
      const author = await makeUser('rater');

      const held = await withHolder(
        (tx) => tx.$queryRaw`SELECT id FROM "Book" WHERE id = ${f.bookId} FOR UPDATE`,
        async (holderPid, tx) => {
          const op = settle(
            comments.create(author, { bookVersionId: f.low, text: 'rated', rating: 5 } as never),
          );
          const blocked = await waitBlockedBy(prisma, holderPid);
          await tx.$queryRaw`SELECT id FROM "BookVersion" WHERE "bookId" = ${f.bookId} ORDER BY id FOR UPDATE`;
          return { op, blocked };
        },
      );

      expect(held.blocked).toBe(true);
      expect(text(await held.op)).toBe('');
    });
  });

  describe('ответ против удаления аккаунта автора корня (LEGACY-433)', () => {
    const makeThread = async () => {
      const f = await makeBook();
      const owner = await makeUser('owner');
      const replier = await makeUser('replier');
      const root = await prisma.comment.create({
        data: { userId: owner, bookVersionId: f.low, text: 'root' },
      });
      return { f, owner, replier, root };
    };

    it('реальное удаление аккаунта: ответ, записанный раньше, остаётся корневым, ответ позже — 404', async () => {
      const { f, owner, replier, root } = await makeThread();
      await comments.create(replier, {
        bookVersionId: f.low,
        parentId: root.id,
        text: 'reply-before',
      } as never);

      await users.deleteById(owner, null);
      userIds.splice(userIds.indexOf(owner), 1);

      const before = await prisma.comment.findFirst({ where: { text: 'reply-before' } });
      expect(before?.parentId).toBeNull();
      await expect(
        comments.create(replier, {
          bookVersionId: f.low,
          parentId: root.id,
          text: 'reply-after',
        } as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

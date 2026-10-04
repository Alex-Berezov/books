import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { BookType, CategoryType, Language, Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { LikesService } from '../src/modules/likes/likes.service';
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
  let likes: LikesService;

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
    likes = moduleRef.get(LikesService);
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

  /**
   * `T97`. `Like` крепится только к версии и к комментарию (`schema.prisma`, модель `Like`):
   * вставка — один оператор с одной проверкой внешнего ключа на цель, ждать ей больше нечего,
   * цикла с каскадом нет; цель, стёртая за время ожидания, — 404 (`P2003` в `LikesService`).
   * Снятие комментария до правки запирало строку комментария раньше книги, а каскад книги
   * сносит оценку и обнуляет `Comment.ratingId` — `deadlock detected` в гонке отзыва
   * с удалением книги и `P2025` (500), когда комментарий стёрт между чтением и записью.
   * Удаление аккаунта сносило лайки и отзывы автора раньше, чем каскад книги, держащий версию,
   * добирался до тех же строк, — `deadlock detected`.
   * Проба на отказ: без `lockTargets` в `CommentsService.remove` красные оба кейса снятия
   * комментария; без `lockUserContentTargets` в `UsersService.deleteById` — кейс удаления аккаунта
   * против удаления книги.
   */
  describe('лайки и снятие комментария против каскада (LEGACY-433, T97)', () => {
    /**
     * Держатель — удаление книги: строка книги `FOR UPDATE`, затем (`commentId` задан) версии
     * `ORDER BY id` и строка комментария, как их запер бы каскад, пока писатель ждёт. Писатель
     * стартует, держатель дожидается его в очереди и сносит книгу настоящим каскадом.
     */
    const againstBookRemoval = (
      bookId: string,
      commentId: string | null,
      writer: () => Promise<unknown>,
    ) =>
      withHolder(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Book" WHERE id = ${bookId} FOR UPDATE`;
          if (commentId === null) return;
          await tx.$queryRaw`SELECT id FROM "BookVersion" WHERE "bookId" = ${bookId} ORDER BY id FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM "Comment" WHERE id = ${commentId} FOR UPDATE`;
        },
        async (holderPid, tx) => {
          const op = settle(writer());
          const blocked = await waitBlockedBy(prisma, holderPid);
          await tx.$queryRaw`SELECT id FROM "BookVersion" WHERE "bookId" = ${bookId} ORDER BY id FOR UPDATE`;
          await tx.book.delete({ where: { id: bookId } });
          return { op, blocked };
        },
      );

    it('лайк версии против удаления версии — 404, а не P2003 и 500', async () => {
      const f = await makeBook();
      const reader = await makeUser('liker');

      const held = await withHolder(
        (tx) => lockVersion(tx, f.low),
        async (holderPid, tx) => {
          const op = settle(likes.like(reader, { bookVersionId: f.low }));
          const blocked = await waitBlockedBy(prisma, holderPid);
          await tx.bookVersion.delete({ where: { id: f.low } });
          return { op, blocked };
        },
      );

      expect(held.blocked).toBe(true);
      const writer = await held.op;
      expect(writer.status).toBe('rejected');
      expect((writer as PromiseRejectedResult).reason).toBeInstanceOf(NotFoundException);
    });

    it('лайк комментария против удаления книги: комментарий заперт каскадом — 404, цикла нет', async () => {
      const f = await makeBook();
      const author = await makeUser('c-author');
      const reader = await makeUser('c-liker');
      const comment = await prisma.comment.create({
        data: { userId: author, bookVersionId: f.low, text: 'liked' },
      });

      const held = await againstBookRemoval(f.bookId, comment.id, () =>
        likes.like(reader, { commentId: comment.id }),
      );

      expect(held.blocked).toBe(true);
      const writer = await held.op;
      expect(writer.status).toBe('rejected');
      expect((writer as PromiseRejectedResult).reason).toBeInstanceOf(NotFoundException);
      expect(await prisma.like.count({ where: { userId: reader } })).toBe(0);
    });

    it('снятие комментария против удаления книги: комментарий снесён между чтением и записью — не 500', async () => {
      const f = await makeBook();
      const author = await makeUser('remover');
      const comment = await prisma.comment.create({
        data: { userId: author, bookVersionId: f.low, text: 'to-remove' },
      });

      const held = await againstBookRemoval(f.bookId, comment.id, () =>
        comments.remove(comment.id, { userId: author, email: 'x@ex.com' }),
      );

      expect(held.blocked).toBe(true);
      expect(text(await held.op)).toBe('');
    });

    it('снятие отзыва с оценкой встаёт за удалением книги на её строке — цикла нет', async () => {
      // Без замка книги снятие запирает строку комментария и удаляет оценку мимо держателя, а каскад
      // книги, снёсший оценку, ждал бы строку комментария для `SET NULL` — `deadlock detected`.
      const f = await makeBook();
      const author = await makeUser('rr');
      const review = (await comments.create(author, {
        bookVersionId: f.low,
        text: 'rated',
        rating: 4,
      } as never)) as { id: string };

      const held = await againstBookRemoval(f.bookId, null, () =>
        comments.remove(review.id, { userId: author, email: 'x@ex.com' }),
      );

      expect(held.blocked).toBe(true);
      expect(text(await held.op)).toBe('');
      expect(await prisma.comment.count({ where: { id: review.id } })).toBe(0);
      expect(await prisma.bookRating.count({ where: { userId: author } })).toBe(0);
    });

    it('удаление аккаунта против удаления книги: комментарий заперт каскадом — не 500', async () => {
      // `deleteById` сносит лайки и отзывы автора; каскад книги сносит те же строки по версии.
      const f = await makeBook();
      const author = await makeUser('leaver');
      const review = (await comments.create(author, {
        bookVersionId: f.low,
        text: 'rated-leaver',
        rating: 3,
      } as never)) as { id: string };
      await likes.like(author, { bookVersionId: f.low });

      const held = await againstBookRemoval(f.bookId, review.id, () =>
        users.deleteById(author, null),
      );

      expect(held.blocked).toBe(true);
      expect(text(await held.op)).toBe('');
      userIds.splice(userIds.indexOf(author), 1);
      expect(await prisma.user.count({ where: { id: author } })).toBe(0);
    });

    it('удаление аккаунта против удаления версии: встаёт за строкой версии — не 500', async () => {
      const f = await makeBook();
      const author = await makeUser('leaver-v');
      await prisma.comment.create({ data: { userId: author, bookVersionId: f.low, text: 'v' } });
      await likes.like(author, { bookVersionId: f.low });

      const held = await withHolder(
        (tx) => lockVersion(tx, f.low),
        async (holderPid, tx) => {
          const op = settle(users.deleteById(author, null));
          const blocked = await waitBlockedBy(prisma, holderPid);
          // Как `BookVersionService.remove`: строка версии заперта, удаление — каскадом.
          await tx.bookVersion.delete({ where: { id: f.low } });
          return { op, blocked };
        },
      );

      expect(held.blocked).toBe(true);
      expect(text(await held.op)).toBe('');
      userIds.splice(userIds.indexOf(author), 1);
      expect(await prisma.user.count({ where: { id: author } })).toBe(0);
    });
  });
  /**
   * `T101`. Остаток `LEGACY-433` про `UsersService.deleteById`: встречный порядок строк `Comment`
   * со снятием комментария, каскад главы «глава → комментарии → лайки» и обнуление
   * `BookVersion.rightsGeoBlockVerifiedByUserId` при удалении пользователя. Держатель берёт строки
   * в порядке соперника, ждёт, пока писатель встанет за ним, и делает следующий шаг соперника;
   * цикл — `40P01` у одной из сторон.
   * Проба на отказ 04.10.2026, по частям правки: без замка ответов по `id` в
   * `CommentsService.remove` краснеет «снятие корня с двумя ответами», без `ORDER BY` в замке
   * комментариев `deleteById` — «удаление аккаунта автора двух ответов», без раннего
   * `FOR NO KEY UPDATE` версий сверки — оба кейса «сверяющего версию» против главы, без
   * `KEY SHARE` на главы — оба кейса «двух комментариев к ней», без чужих прямых ответов в замке
   * комментариев — «два аккаунта, ответившие друг другу». Без правки целиком красные первые восемь.
   */
  describe('удаление аккаунта против встречных писателей (LEGACY-433, T101)', () => {
    type Tx = Prisma.TransactionClient;

    /**
     * Писатель дожидается всегда, даже если транзакция держателя упала: иначе он доживал бы
     * на своём соединении до чистки, а проверка смотрела бы на заглушку.
     */
    const race = async (
      lockFirst: (tx: Tx) => Promise<unknown>,
      writer: () => Promise<unknown>,
      holderStep: (tx: Tx) => Promise<unknown>,
    ) => {
      let op: Promise<PromiseSettledResult<unknown>> | undefined;
      const holder = await settle(
        withHolder(lockFirst, async (holderPid, tx) => {
          op = settle(writer());
          const blocked = await waitBlockedBy(prisma, holderPid);
          return { blocked, step: text(await settle(holderStep(tx))) };
        }),
      );
      return { holder, writer: op ? text(await op) : 'писатель не стартовал' };
    };

    const expectNoCycle = (r: Awaited<ReturnType<typeof race>>) => {
      expect(text(r.holder)).toBe('');
      const held = (r.holder as PromiseFulfilledResult<{ blocked: boolean; step: string }>).value;
      expect(held.blocked).toBe(true);
      expect(held.step).toBe('');
      expect(r.writer).toBe('');
    };

    const forget = (userId: string) => {
      const at = userIds.indexOf(userId);
      if (at >= 0) userIds.splice(at, 1);
    };

    const lockComment = (tx: Tx, id: string) =>
      tx.$queryRaw`SELECT id FROM "Comment" WHERE id = ${id} FOR UPDATE`;

    it('снятие комментария с ответами против удаления аккаунта его автора — цикла нет', async () => {
      const f = await makeBook();
      const author = await makeUser('t101-root');
      const replier = await makeUser('t101-reply');
      const root = await prisma.comment.create({
        data: { userId: author, bookVersionId: f.low, text: 'root' },
      });
      const reply = await prisma.comment.create({
        data: { userId: replier, bookVersionId: f.low, text: 'reply', parentId: root.id },
      });

      // Держатель — `CommentsService.remove`: сначала строка корня, потом его ответы.
      const r = await race(
        (tx) => lockComment(tx, root.id),
        () => users.deleteById(author, null),
        (tx) => tx.comment.updateMany({ where: { parentId: root.id }, data: { isDeleted: true } }),
      );

      expectNoCycle(r);
      forget(author);
      expect(await prisma.comment.count({ where: { id: root.id } })).toBe(0);
      const left = await prisma.comment.findUnique({ where: { id: reply.id } });
      expect(left).toMatchObject({ parentId: null, isDeleted: true });
    });

    /**
     * Два ответа одного автора под чужим корнем, `id` против порядка вставки: `updateMany` в
     * `CommentsService.remove` берёт строки в физическом порядке (по вставке), а `deleteById` —
     * по `id`. Обе стороны запирают ответы по `id` — кейсы держат каждую по отдельности.
     */
    const makeInvertedReplies = async () => {
      const f = await makeBook();
      const owner = await makeUser('t101-owner');
      const leaver = await makeUser('t101-leaver');
      const root = await prisma.comment.create({
        data: { userId: owner, bookVersionId: f.low, text: 'root' },
      });
      const n = userIds.length;
      // Старший `id` вставлен первым — физический порядок обратен порядку `id`.
      const high = await prisma.comment.create({
        data: {
          id: `t101-z-${stamp}-${n}`,
          userId: leaver,
          bookVersionId: f.low,
          text: 'r-high',
          parentId: root.id,
        },
      });
      const low = await prisma.comment.create({
        data: {
          id: `t101-a-${stamp}-${n}`,
          userId: leaver,
          bookVersionId: f.low,
          text: 'r-low',
          parentId: root.id,
        },
      });
      return { owner, leaver, root, high, low };
    };

    it('снятие корня с двумя ответами одного автора: ответы по id, как у удаления аккаунта — цикла нет', async () => {
      const { owner, root, high, low } = await makeInvertedReplies();

      // Держатель — `deleteById` автора ответов: младший `id`, потом старший.
      const r = await race(
        (tx) => lockComment(tx, low.id),
        () => comments.remove(root.id, { userId: owner, email: 'x@ex.com' }),
        (tx) => lockComment(tx, high.id),
      );

      expectNoCycle(r);
      expect(await prisma.comment.count({ where: { parentId: root.id, isDeleted: true } })).toBe(2);
    });

    it('удаление аккаунта автора двух ответов: ответы по id, как у снятия корня — цикла нет', async () => {
      const { leaver, root, high, low } = await makeInvertedReplies();

      // Держатель — `CommentsService.remove` корня: корень, потом ответы по `id`.
      const r = await race(
        async (tx) => {
          await lockComment(tx, root.id);
          await lockComment(tx, low.id);
        },
        () => users.deleteById(leaver, null),
        (tx) => lockComment(tx, high.id),
      );

      expectNoCycle(r);
      forget(leaver);
      expect(await prisma.comment.count({ where: { id: { in: [low.id, high.id] } } })).toBe(0);
    });

    /**
     * Глава или аудиоглава на младшей версии и комментарий `userId` к ней (`id` — свой, если задан);
     * `ref` — привязка к цели для следующих комментариев.
     */
    const makeChapterComment = async (
      kind: string,
      f: { low: string },
      userId: string,
      id?: string,
    ) => {
      if (kind === 'глава') {
        const chapter = await prisma.chapter.create({
          data: { bookVersionId: f.low, number: 1, title: 't', content: 'c' },
        });
        const ref = { chapterId: chapter.id };
        const comment = await prisma.comment.create({ data: { id, userId, ...ref, text: 'c' } });
        return {
          comment,
          ref,
          lock: (tx: Tx) =>
            tx.$queryRaw`SELECT id FROM "Chapter" WHERE id = ${chapter.id} FOR UPDATE`,
          remove: (tx: Tx) => tx.chapter.delete({ where: { id: chapter.id } }),
        };
      }
      const audio = await prisma.audioChapter.create({
        data: {
          bookVersionId: f.low,
          number: 1,
          title: 't',
          audioUrl: 'https://example.com/a.mp3',
          duration: 1,
        },
      });
      const ref = { audioChapterId: audio.id };
      const comment = await prisma.comment.create({ data: { id, userId, ...ref, text: 'c' } });
      return {
        comment,
        ref,
        lock: (tx: Tx) =>
          tx.$queryRaw`SELECT id FROM "AudioChapter" WHERE id = ${audio.id} FOR UPDATE`,
        remove: (tx: Tx) => tx.audioChapter.delete({ where: { id: audio.id } }),
      };
    };

    // Держатель — удаление главы под `runInLockedClearance`: версия `FOR NO KEY UPDATE`, строка
    // главы, её комментарий; дальше каскад сносит главу, комментарии и их лайки.
    const holdChapter =
      (versionId: string, target: { lock: (tx: Tx) => Promise<unknown> }, commentId: string) =>
      async (tx: Tx) => {
        await tx.$queryRaw`SELECT id FROM "BookVersion" WHERE id = ${versionId} FOR NO KEY UPDATE`;
        await target.lock(tx);
        await lockComment(tx, commentId);
      };

    it.each([['глава'], ['аудиоглава']])(
      '%s: удаление против удаления аккаунта автора комментария с чужим лайком — цикла нет',
      async (kind) => {
        const f = await makeBook();
        const author = await makeUser('t101-ch-author');
        const liker = await makeUser('t101-ch-liker');
        const target = await makeChapterComment(kind, f, author);
        await prisma.like.create({ data: { userId: liker, commentId: target.comment.id } });

        const r = await race(
          holdChapter(f.low, target, target.comment.id),
          () => users.deleteById(author, null),
          (tx) => target.remove(tx),
        );

        expectNoCycle(r);
        forget(author);
      },
    );

    it.each([['глава'], ['аудиоглава']])(
      '%s: удаление против удаления аккаунта автора двух комментариев к ней, id против порядка вставки — цикла нет',
      async (kind) => {
        // Каскад главы сносит комментарии в физическом порядке (по вставке), удаление аккаунта
        // запирает их по `id`; встаёт же оно раньше — за строкой главы.
        const f = await makeBook();
        const author = await makeUser('t101-ch-two');
        const n = userIds.length;
        const target = await makeChapterComment(kind, f, author, `t101-z-${stamp}-${n}`);
        await prisma.comment.create({
          data: { id: `t101-a-${stamp}-${n}`, userId: author, ...target.ref, text: 'c2' },
        });

        const r = await race(
          holdChapter(f.low, target, target.comment.id),
          () => users.deleteById(author, null),
          (tx) => target.remove(tx),
        );

        expectNoCycle(r);
        forget(author);
      },
    );

    it('два аккаунта, ответившие друг другу, удаляются встречно — цикла нет', async () => {
      // У A корень a и ответ на корень B, у B — наоборот; ответ B на a младше по `id`.
      const f = await makeBook();
      const leaverA = await makeUser('t101-cross-a');
      const leaverB = await makeUser('t101-cross-b');
      const n = userIds.length;
      const rootA = await prisma.comment.create({
        data: { userId: leaverA, bookVersionId: f.low, text: 'root-a' },
      });
      const rootB = await prisma.comment.create({
        data: { userId: leaverB, bookVersionId: f.low, text: 'root-b' },
      });
      const replyAtoB = await prisma.comment.create({
        data: {
          id: `t101-y-${stamp}-${n}`,
          userId: leaverA,
          bookVersionId: f.low,
          text: 'a->b',
          parentId: rootB.id,
        },
      });
      const replyBtoA = await prisma.comment.create({
        data: {
          id: `t101-b-${stamp}-${n}`,
          userId: leaverB,
          bookVersionId: f.low,
          text: 'b->a',
          parentId: rootA.id,
        },
      });

      // Держатель — `deleteById(B)` в общем порядке: корень B, потом ответы по `id` (младший —
      // ответ B на a), затем отвязка чужого ответа A на корень B.
      const r = await race(
        async (tx) => {
          await lockComment(tx, rootB.id);
          await lockComment(tx, replyBtoA.id);
        },
        () => users.deleteById(leaverA, null),
        (tx) => lockComment(tx, replyAtoB.id),
      );

      expectNoCycle(r);
      forget(leaverA);
      expect(await prisma.comment.count({ where: { id: { in: [rootA.id, replyAtoB.id] } } })).toBe(
        0,
      );
      expect(await prisma.comment.findUnique({ where: { id: replyBtoA.id } })).toMatchObject({
        parentId: null,
      });
    });

    it.each([['глава'], ['аудиоглава']])(
      '%s: удаление против удаления аккаунта сверяющего версию с лайком на чужой комментарий — цикла нет',
      async (kind) => {
        const f = await makeBook();
        const author = await makeUser('t101-geo-ch-author');
        const verifier = await makeUser('t101-geo-ch-verifier');
        await prisma.bookVersion.update({
          where: { id: f.low },
          data: { rightsGeoBlockVerifiedByUserId: verifier },
        });
        const target = await makeChapterComment(kind, f, author);
        await prisma.like.create({ data: { userId: verifier, commentId: target.comment.id } });

        const r = await race(
          holdChapter(f.low, target, target.comment.id),
          () => users.deleteById(verifier, null),
          (tx) => target.remove(tx),
        );

        expectNoCycle(r);
        forget(verifier);
        const version = await prisma.bookVersion.findUnique({ where: { id: f.low } });
        expect(version?.rightsGeoBlockVerifiedByUserId).toBeNull();
      },
    );

    it('аккаунт сверяющего версию с лайком на чужой комментарий против удаления книги — цикла нет', async () => {
      const f = await makeBook();
      const author = await makeUser('t101-geo-author');
      const verifier = await makeUser('t101-geo-verifier');
      await prisma.bookVersion.update({
        where: { id: f.high },
        data: { rightsGeoBlockVerifiedByUserId: verifier },
      });
      const comment = await prisma.comment.create({
        data: { userId: author, bookVersionId: f.low, text: 'liked' },
      });
      await prisma.like.create({ data: { userId: verifier, commentId: comment.id } });

      const r = await race(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Book" WHERE id = ${f.bookId} FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM "BookVersion" WHERE "bookId" = ${f.bookId} ORDER BY id FOR UPDATE`;
        },
        () => users.deleteById(verifier, null),
        (tx) => tx.book.delete({ where: { id: f.bookId } }),
      );

      expectNoCycle(r);
      forget(verifier);
    });
  });
});

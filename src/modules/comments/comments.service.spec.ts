import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import { PUBLIC_COMMENT_USER_SELECT } from '../../common/selects/public-comment-user.select';
import { CommentsService } from './comments.service';
import { CreateCommentDto } from './dto/create-comment.dto';

/**
 * Аргумент `$transaction`. Колбэчная ветка записана образцом из
 * `book-version.service.spec.ts`: на место `tx` приходит сам стаб, а возврат
 * колбэка становится возвратом транзакции. Списочную форму Prisma принимает
 * наравне с колбэком, и `list()` зовёт именно её, поэтому она остаётся вторым
 * вариантом аргумента.
 */
type TransactionArg<T = unknown> = Promise<T>[] | ((tx: PrismaStub) => Promise<T> | T);

interface PrismaStub {
  $transaction: jest.Mock<Promise<unknown>, [TransactionArg]>;
  $queryRaw: jest.Mock;
  comment: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  userRole: { findMany: jest.Mock };
  bookVersion: { findUnique: jest.Mock };
  chapter: { findUnique: jest.Mock };
  audioChapter: { findUnique: jest.Mock };
}

const createPrismaStub = (): PrismaStub => {
  const stub: PrismaStub = {
    $transaction: jest.fn(async (arg: TransactionArg) => {
      if (typeof arg === 'function') {
        return arg(stub);
      }
      const results: unknown[] = [];
      for (const op of arg) {
        results.push(await op);
      }
      return results;
    }),
    // Замок корня ветки (`LEGACY-428`): по умолчанию корень под замком живой и видимый.
    $queryRaw: jest.fn(() =>
      Promise.resolve([{ isDeleted: false, isHidden: false, userId: 'author' }]),
    ),
    comment: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    userRole: { findMany: jest.fn() },
    bookVersion: { findUnique: jest.fn() },
    chapter: { findUnique: jest.fn() },
    audioChapter: { findUnique: jest.fn() },
  };
  return stub;
};

describe('CommentsService', () => {
  let service: CommentsService;
  let prisma: PrismaStub;

  beforeEach(() => {
    prisma = createPrismaStub();
    // Сервис ролей здесь **настоящий**, а не стаб: он читает тот же `userRole`,
    // что уже застаблен ниже. Стаб на его месте превратил бы проверку «модератор
    // ли это» в проверку самого стаба.
    const moderatorRoles = new ModeratorRolesService(prisma as unknown as PrismaService);
    service = new CommentsService(prisma as unknown as PrismaService, moderatorRoles);
  });

  // Сторож `LEGACY-170` выставляет список почт; снимать его надо здесь, иначе
  // упавшее ожидание унесёт переменную в остальные файлы воркера.
  afterEach(() => {
    delete process.env.ADMIN_EMAILS;
  });

  describe('create()', () => {
    it('throws NotFound if parent missing or deleted', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.create('u1', {
          parentId: 'p1',
          bookVersionId: 'v1',
          text: 'hi',
        } as CreateCommentDto),
      ).rejects.toBeInstanceOf(NotFoundException);

      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'p1', isDeleted: true });
      await expect(
        service.create('u1', {
          parentId: 'p1',
          bookVersionId: 'v1',
          text: 'hi',
        } as CreateCommentDto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('validates target existence for version/chapter/audio', async () => {
      // version missing
      prisma.comment.findUnique.mockResolvedValueOnce({
        id: 'p1',
        isDeleted: false,
        bookVersionId: 'v1',
        chapterId: null,
        audioChapterId: null,
      });
      prisma.bookVersion.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.create('u1', {
          parentId: 'p1',
          bookVersionId: 'v1',
          text: 't',
        } as CreateCommentDto),
      ).rejects.toBeInstanceOf(NotFoundException);

      // chapter missing
      prisma.comment.findUnique.mockResolvedValueOnce(undefined);
      prisma.chapter.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.create('u1', { chapterId: 'c1', text: 't' } as CreateCommentDto),
      ).rejects.toBeInstanceOf(NotFoundException);

      // audio missing
      prisma.audioChapter.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.create('u1', { audioChapterId: 'a1', text: 't' } as CreateCommentDto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('creates comment when validations pass', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce(undefined);
      prisma.bookVersion.findUnique.mockResolvedValueOnce({ id: 'v1' });
      const created = { id: 'c1', text: 'hello' };
      prisma.comment.create.mockResolvedValueOnce(created);
      const res = await service.create('u1', {
        bookVersionId: 'v1',
        text: 'hello',
      } as CreateCommentDto);
      expect(res).toEqual({ ...created, ratingScore: null });
      expect(prisma.comment.create).toHaveBeenCalled();
    });

    describe('глубина ветки (LEGACY-366)', () => {
      const createdParentId = () => {
        expect(prisma.comment.create).toHaveBeenCalledTimes(1);
        return (prisma.comment.create.mock.calls[0][0] as { data: { parentId?: string } }).data
          .parentId;
      };
      const row = (
        id: string,
        parentId: string | null,
        { isDeleted = false, isHidden = false, userId = 'author' } = {},
      ) => ({
        id,
        parentId,
        isDeleted,
        isHidden,
        userId,
        bookVersionId: 'v1',
        chapterId: null,
        audioChapterId: null,
      });

      beforeEach(() => {
        prisma.bookVersion.findUnique.mockResolvedValue({ id: 'v1', bookId: 'b1' });
        prisma.comment.create.mockResolvedValue({ id: 'new', rating: null });
      });

      it('ответ на ответ крепится к корню ветки', async () => {
        prisma.comment.findUnique
          .mockResolvedValueOnce(row('reply', 'root'))
          .mockResolvedValueOnce(row('root', null));
        await service.create('u1', {
          parentId: 'reply',
          bookVersionId: 'v1',
          text: 't',
        } as CreateCommentDto);
        expect(createdParentId()).toBe('root');
      });

      it('ответ на корень остаётся под корнем', async () => {
        prisma.comment.findUnique.mockResolvedValueOnce(row('root', null));
        await service.create('u1', {
          parentId: 'root',
          bookVersionId: 'v1',
          text: 't',
        } as CreateCommentDto);
        expect(createdParentId()).toBe('root');
      });

      it('ответ в старой цепочке глубже двух встаёт под самый корень', async () => {
        prisma.comment.findUnique
          .mockResolvedValueOnce(row('q', 'c'))
          .mockResolvedValueOnce(row('c', 'root'))
          .mockResolvedValueOnce(row('root', null));
        await service.create('u1', {
          parentId: 'q',
          bookVersionId: 'v1',
          text: 't',
        } as CreateCommentDto);
        expect(createdParentId()).toBe('root');
      });

      it('удалённый предок старой цепочки — 404, комментарий не создаётся', async () => {
        prisma.comment.findUnique
          .mockResolvedValueOnce(row('q', 'c'))
          .mockResolvedValueOnce(row('c', 'root', { isDeleted: true }))
          // Корень живой: без проверки удалённого предка ответ был бы создан.
          .mockResolvedValueOnce(row('root', null));
        await expect(
          service.create('u1', {
            parentId: 'q',
            bookVersionId: 'v1',
            text: 't',
          } as CreateCommentDto),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(prisma.comment.create).not.toHaveBeenCalled();
      });

      const reply = (parentId: string, userId = 'u1') =>
        service.create(userId, { parentId, bookVersionId: 'v1', text: 't' } as CreateCommentDto);

      it('скрытый корень: ответ на видимый ответ под ним — 404', async () => {
        prisma.comment.findUnique
          .mockResolvedValueOnce(row('c', 'root'))
          .mockResolvedValueOnce(row('root', null, { isHidden: true }));
        await expect(reply('c')).rejects.toBeInstanceOf(NotFoundException);
        expect(prisma.comment.create).not.toHaveBeenCalled();
      });

      it('скрытый корень: прямой ответ на него — 404', async () => {
        prisma.comment.findUnique.mockResolvedValueOnce(row('root', null, { isHidden: true }));
        await expect(reply('root')).rejects.toBeInstanceOf(NotFoundException);
        expect(prisma.comment.create).not.toHaveBeenCalled();
      });

      it('автор скрытого корня отвечает в своей ветке — под корень', async () => {
        prisma.comment.findUnique
          .mockResolvedValueOnce(row('c', 'root'))
          .mockResolvedValueOnce(row('root', null, { isHidden: true, userId: 'u1' }));
        await reply('c', 'u1');
        expect(createdParentId()).toBe('root');
      });

      it('скрытый ответ при видимом корне — ответ встаёт под корень', async () => {
        prisma.comment.findUnique
          .mockResolvedValueOnce(row('c', 'root', { isHidden: true }))
          .mockResolvedValueOnce(row('root', null));
        await reply('c');
        expect(createdParentId()).toBe('root');
      });

      it('цепочка длиннее потолка подъёма — 404', async () => {
        prisma.comment.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve(row(where.id, `${where.id}+`)),
        );
        await expect(reply('n')).rejects.toBeInstanceOf(NotFoundException);
        expect(prisma.comment.findUnique).toHaveBeenCalledTimes(33);
        expect(prisma.comment.create).not.toHaveBeenCalled();
      });

      it('ответ с оценкой — 400, оценка книги не трогается (LEGACY-428)', async () => {
        prisma.comment.findUnique.mockResolvedValueOnce(row('root', null));
        await expect(
          service.create('u1', {
            parentId: 'root',
            bookVersionId: 'v1',
            text: 't',
            rating: 1,
          } as CreateCommentDto),
        ).rejects.toThrow('Rating cannot be attached to a reply');
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      describe('цель ответа сверяется с целью корня (LEGACY-428)', () => {
        const onChapter = (id: string) => ({
          ...row(id, null),
          bookVersionId: null,
          chapterId: 'ch1',
        });
        const mismatch = 'Reply target must match the thread root target';

        it.each([
          ['другая версия', { bookVersionId: 'v2' }],
          ['глава вместо версии корня', { chapterId: 'v1' }],
          ['цели нет вовсе', {}],
        ])('%s — 400, ответ не создаётся', async (_, target) => {
          prisma.comment.findUnique.mockResolvedValueOnce(row('root', null));
          await expect(
            service.create('u1', { parentId: 'root', text: 't', ...target } as CreateCommentDto),
          ).rejects.toThrow(mismatch);
          expect(prisma.comment.create).not.toHaveBeenCalled();
        });

        it('корень на главе: ответ на ту же главу создаётся, на другую — 400', async () => {
          prisma.chapter.findUnique.mockResolvedValue({ id: 'ch1' });
          prisma.comment.findUnique.mockResolvedValueOnce(onChapter('root'));
          await service.create('u1', {
            parentId: 'root',
            chapterId: 'ch1',
            text: 't',
          } as CreateCommentDto);
          expect(createdParentId()).toBe('root');

          prisma.comment.findUnique.mockResolvedValueOnce(onChapter('root'));
          await expect(
            service.create('u1', {
              parentId: 'root',
              chapterId: 'ch2',
              text: 't',
            } as CreateCommentDto),
          ).rejects.toThrow(mismatch);
        });
      });

      describe('замок корня в транзакции записи (LEGACY-428)', () => {
        const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');
        /** Цель и пользователь под замком на месте, корень — такой, как передан. */
        const lockedRootIs = (locked: object | undefined) =>
          prisma.$queryRaw.mockImplementation((strings: TemplateStringsArray, id: unknown) =>
            Promise.resolve(
              strings.join('?').includes('"Comment"') ? (locked ? [locked] : []) : [{ id }],
            ),
          );

        it.each([
          [
            'BookVersion',
            { bookVersionId: 'v1', chapterId: null, audioChapterId: null },
            { bookVersionId: 'v1' },
          ],
          [
            'Chapter',
            { bookVersionId: null, chapterId: 'ch1', audioChapterId: null },
            { chapterId: 'ch1' },
          ],
          [
            'AudioChapter',
            { bookVersionId: null, chapterId: null, audioChapterId: 'a1' },
            { audioChapterId: 'a1' },
          ],
        ])(
          'порядок: автор, цель %s, потом корень FOR SHARE',
          async (table, rootTarget, dtoTarget) => {
            prisma.chapter.findUnique.mockResolvedValue({ id: 'ch1' });
            prisma.audioChapter.findUnique.mockResolvedValue({ id: 'a1' });
            prisma.comment.findUnique.mockResolvedValueOnce({
              ...row('root', null),
              ...rootTarget,
            });
            await service.create('u1', {
              parentId: 'root',
              text: 't',
              ...dtoTarget,
            } as CreateCommentDto);

            const calls = prisma.$queryRaw.mock.calls;
            expect(calls.map(sqlOf)).toEqual([
              'SELECT id FROM "User" WHERE id = ? FOR KEY SHARE',
              `SELECT id FROM "${table}" WHERE id = ? FOR KEY SHARE`,
              expect.stringMatching(/FROM "Comment" WHERE id = \? FOR SHARE$/),
            ]);
            expect(calls.map((call: unknown[]) => call[1])).toEqual([
              'u1',
              Object.values(dtoTarget)[0],
              'root',
            ]);
            expect(createdParentId()).toBe('root');
          },
        );

        it.each([
          ['скрыт', { isDeleted: false, isHidden: true, userId: 'author' }],
          ['удалён', { isDeleted: true, isHidden: false, userId: 'author' }],
          ['стёрт каскадом', undefined],
        ])('корень %s между проверкой и записью — 404, ответ не создаётся', async (_, locked) => {
          prisma.comment.findUnique.mockResolvedValueOnce(row('root', null));
          lockedRootIs(locked);
          await expect(reply('root')).rejects.toThrow('Parent comment not found');
          expect(prisma.comment.create).not.toHaveBeenCalled();
        });

        it('цель корня стёрта, пока ответ ждал замок, — 404 ветки, а не 500 (LEGACY-434)', async () => {
          prisma.comment.findUnique.mockResolvedValueOnce(row('root', null));
          prisma.$queryRaw.mockResolvedValueOnce([{ id: 'u1' }]).mockResolvedValueOnce([]);
          await expect(reply('root')).rejects.toThrow('Parent comment not found');
          expect(prisma.comment.create).not.toHaveBeenCalled();
        });

        it('отвечающий удалён, пока ждал замок, — 404, а не 500 на внешнем ключе', async () => {
          prisma.comment.findUnique.mockResolvedValueOnce(row('root', null));
          prisma.$queryRaw.mockResolvedValueOnce([]);
          await expect(reply('root')).rejects.toThrow('User not found');
          expect(prisma.comment.create).not.toHaveBeenCalled();
        });

        it('автор отвечает в свой корень, скрытый между проверкой и записью, — под корень', async () => {
          prisma.comment.findUnique.mockResolvedValueOnce(row('root', null, { userId: 'u1' }));
          lockedRootIs({ isDeleted: false, isHidden: true, userId: 'u1' });
          await reply('root', 'u1');
          expect(createdParentId()).toBe('root');
        });

        it('транзакция ответа ждёт замки дольше дефолта Prisma (L-020)', async () => {
          prisma.comment.findUnique.mockResolvedValueOnce(row('root', null));
          await reply('root');
          expect(prisma.$transaction).toHaveBeenCalledTimes(1);
          expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
            timeout: 30_000,
            maxWait: 10_000,
          });
        });
      });

      describe('замки корневого комментария (LEGACY-434)', () => {
        const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');
        const lockedSql = () => prisma.$queryRaw.mock.calls.map(sqlOf);

        it('корневой комментарий создаётся без родителя: автор, потом цель', async () => {
          await service.create('u1', { bookVersionId: 'v1', text: 't' } as CreateCommentDto);
          expect(createdParentId()).toBeUndefined();
          expect(lockedSql()).toEqual([
            'SELECT id FROM "User" WHERE id = ? FOR KEY SHARE',
            'SELECT id FROM "BookVersion" WHERE id = ? FOR KEY SHARE',
          ]);
          expect(prisma.$queryRaw.mock.calls.map((call: unknown[]) => call[1])).toEqual([
            'u1',
            'v1',
          ]);
        });

        it.each([
          ['Chapter', { chapterId: 'ch1' }, 'ch1'],
          ['AudioChapter', { audioChapterId: 'a1' }, 'a1'],
        ])('цель %s запирается своей таблицей', async (table, target, id) => {
          prisma.chapter.findUnique.mockResolvedValue({ id: 'ch1' });
          prisma.audioChapter.findUnique.mockResolvedValue({ id: 'a1' });
          await service.create('u1', { ...target, text: 't' } as CreateCommentDto);
          expect(lockedSql()).toEqual([
            'SELECT id FROM "User" WHERE id = ? FOR KEY SHARE',
            `SELECT id FROM "${table}" WHERE id = ? FOR KEY SHARE`,
          ]);
          expect(prisma.$queryRaw.mock.calls[1][1]).toBe(id);
        });

        it.each([
          ['BookVersion', { bookVersionId: 'v1' }],
          ['Chapter', { chapterId: 'ch1' }],
          ['AudioChapter', { audioChapterId: 'a1' }],
        ])('цель %s удалена между проверкой и записью — 404, а не 500', async (table, target) => {
          prisma.chapter.findUnique.mockResolvedValue({ id: 'ch1' });
          prisma.audioChapter.findUnique.mockResolvedValue({ id: 'a1' });
          prisma.$queryRaw.mockResolvedValueOnce([{ id: 'u1' }]).mockResolvedValueOnce([]);
          await expect(
            service.create('u1', { ...target, text: 't' } as CreateCommentDto),
          ).rejects.toThrow(`${table} not found`);
          expect(prisma.comment.create).not.toHaveBeenCalled();
        });

        it('автор удалён, пока ждал замок, — 404, а не 500 на внешнем ключе', async () => {
          prisma.$queryRaw.mockResolvedValueOnce([]);
          await expect(
            service.create('u1', { bookVersionId: 'v1', text: 't' } as CreateCommentDto),
          ).rejects.toThrow('User not found');
          expect(prisma.comment.create).not.toHaveBeenCalled();
        });

        it('отзыв с оценкой запирает книгу раньше версии — порядок BookService.remove', async () => {
          // Стаб оценки только здесь: остальные тесты блока идут без `rating`.
          Object.assign(prisma, {
            bookRating: { upsert: jest.fn().mockResolvedValue({ id: 'r1', score: 5 }) },
          });
          await service.create('u1', {
            bookVersionId: 'v1',
            text: 't',
            rating: 5,
          } as CreateCommentDto);
          expect(lockedSql()).toEqual([
            'SELECT id FROM "User" WHERE id = ? FOR KEY SHARE',
            'SELECT id FROM "Book" WHERE id = ? FOR KEY SHARE',
            'SELECT id FROM "BookVersion" WHERE id = ? FOR KEY SHARE',
          ]);
          expect(prisma.$queryRaw.mock.calls[1][1]).toBe('b1');
        });

        it('книга отзыва с оценкой удалена — 404, оценка не пишется', async () => {
          prisma.$queryRaw.mockResolvedValueOnce([{ id: 'u1' }]).mockResolvedValueOnce([]);
          await expect(
            service.create('u1', {
              bookVersionId: 'v1',
              text: 't',
              rating: 5,
            } as CreateCommentDto),
          ).rejects.toThrow('Book not found');
          expect(prisma.comment.create).not.toHaveBeenCalled();
        });
      });
    });
  });

  describe('get()', () => {
    it('returns comment when exists and not deleted', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1', isDeleted: false });
      const res = await service.get('c1');
      expect(res).toEqual({ id: 'c1', isDeleted: false, ratingScore: null });
    });

    it('throws NotFound when missing or deleted', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce(null);
      await expect(service.get('x')).rejects.toBeInstanceOf(NotFoundException);
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1', isDeleted: true });
      await expect(service.get('c1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update()', () => {
    beforeEach(() => {
      prisma.userRole.findMany.mockResolvedValue([]);
    });

    it('allows author to edit text', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1', userId: 'u1', isDeleted: false });
      prisma.comment.update.mockResolvedValueOnce({ id: 'c1', text: 'new' });
      const res = await service.update('c1', { userId: 'u1', email: 'x@y.z' }, { text: 'new' });
      expect(res).toEqual({ id: 'c1', text: 'new', ratingScore: null });
    });

    it('forbids non-author to edit text without moderator rights', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1', userId: 'u1', isDeleted: false });
      await expect(
        service.update('c1', { userId: 'u2', email: 'x@y.z' }, { text: 'new' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows moderators (by role) to edit text and hide', async () => {
      prisma.comment.findUnique.mockResolvedValue({ id: 'c1', userId: 'u1', isDeleted: false });
      prisma.userRole.findMany.mockResolvedValueOnce([{ role: { name: 'content_manager' } }]);
      prisma.comment.update.mockResolvedValueOnce({ id: 'c1', text: 'm', isHidden: true });
      const res = await service.update(
        'c1',
        { userId: 'mod', email: 'm@site.tld' },
        { text: 'm', isHidden: true },
      );
      expect(res).toEqual({ id: 'c1', text: 'm', isHidden: true, ratingScore: null });
    });

    // 🔴 Сторож `LEGACY-170`: почта из `ADMIN_EMAILS` без строки в `UserRole`
    // модератором не делает. Пока делала, этот же аккаунт скрывал чужие
    // комментарии, но получал 403 на админских маршрутах.
    it('forbids hiding by email list alone', async () => {
      process.env.ADMIN_EMAILS = 'admin@ex.com';
      prisma.comment.findUnique.mockResolvedValue({ id: 'c1', userId: 'u1', isDeleted: false });
      await expect(
        service.update('c1', { userId: 'u2', email: 'admin@ex.com' }, { isHidden: true }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.comment.update).not.toHaveBeenCalled();
    });

    it('returns existing when no changes provided', async () => {
      const existing = { id: 'c1', userId: 'u1', isDeleted: false };
      prisma.comment.findUnique.mockResolvedValueOnce(existing);
      const res = await service.update('c1', { userId: 'u1', email: 'x@y.z' }, {});
      expect(res).toEqual({ id: 'c1', userId: 'u1', isDeleted: false, ratingScore: null });
      expect(prisma.comment.update).not.toHaveBeenCalled();
    });
  });

  describe('moderate()', () => {
    it('delegates to update with isHidden', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1', userId: 'u1', isDeleted: false });
      prisma.userRole.findMany.mockResolvedValueOnce([{ role: { name: 'admin' } }]);
      prisma.comment.update.mockResolvedValueOnce({ id: 'c1', isHidden: true });
      const res = await service.moderate('c1', true, { userId: 'u2', email: 'x@y.z' });
      expect(res).toEqual({ id: 'c1', isHidden: true, ratingScore: null });
    });
  });

  describe('remove()', () => {
    beforeEach(() => {
      prisma.userRole.findMany.mockResolvedValue([]);
    });

    it('is idempotent if already deleted or missing', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce(null);
      await expect(service.remove('c1', { userId: 'u1', email: 'x' })).resolves.toBeUndefined();
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1', isDeleted: true });
      await expect(service.remove('c1', { userId: 'u1', email: 'x' })).resolves.toBeUndefined();
    });

    it('forbids non-author non-moderator', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1', isDeleted: false, userId: 'u1' });
      await expect(service.remove('c1', { userId: 'u2', email: 'x@y.z' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('allows author', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1', isDeleted: false, userId: 'u1' });
      prisma.comment.update.mockResolvedValueOnce({ id: 'c1', isDeleted: true });
      await service.remove('c1', { userId: 'u1', email: 'x' });
      expect(prisma.comment.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { isDeleted: true },
      });
    });

    it('allows moderator', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1', isDeleted: false, userId: 'u1' });
      prisma.userRole.findMany.mockResolvedValueOnce([{ role: { name: 'admin' } }]);
      prisma.comment.update.mockResolvedValueOnce({ id: 'c1', isDeleted: true });
      await service.remove('c1', { userId: 'mod', email: 'm@x' });
      expect(prisma.comment.update).toHaveBeenCalled();
    });

    it('deletes rating if comment has ratingId', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({
        id: 'c1',
        isDeleted: false,
        userId: 'u1',
        ratingId: 'r1',
        bookVersionId: 'v1',
        rating: { bookId: 'b1' },
      });

      const txMock = {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([{ id: 'b1' }])
          .mockResolvedValueOnce([{ id: 'v1' }])
          .mockResolvedValueOnce([{ isDeleted: false, ratingId: 'r1' }]),
        comment: {
          update: jest.fn().mockResolvedValueOnce({ id: 'c1', isDeleted: true }),
          updateMany: jest.fn().mockResolvedValueOnce({ count: 0 }),
        },
        bookRating: {
          delete: jest.fn().mockResolvedValueOnce({ id: 'r1' }),
        },
      };

      prisma.$transaction.mockImplementationOnce((arg) => {
        const runInTransaction = arg as (tx: PrismaStub) => Promise<unknown>;
        return runInTransaction(txMock as unknown as PrismaStub);
      });

      await service.remove('c1', { userId: 'u1', email: 'x' });

      expect(txMock.comment.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { isDeleted: true },
      });
      expect(txMock.comment.updateMany).toHaveBeenCalledWith({
        where: { parentId: 'c1' },
        data: { isDeleted: true },
      });
      expect(txMock.bookRating.delete).toHaveBeenCalledWith({
        where: { id: 'r1' },
      });
    });

    describe('против каскада удаления книги и версии (LEGACY-433, T97)', () => {
      const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');

      it('запирает книгу и версию раньше строки комментария — порядок BookService.remove', async () => {
        prisma.comment.findUnique.mockResolvedValueOnce({
          id: 'c1',
          isDeleted: false,
          userId: 'u1',
          ratingId: 'r1',
          bookVersionId: 'v1',
          rating: { bookId: 'b1' },
        });
        prisma.$queryRaw
          .mockResolvedValueOnce([{ id: 'b1' }])
          .mockResolvedValueOnce([{ id: 'v1' }])
          .mockResolvedValueOnce([{ isDeleted: false, ratingId: null }]);

        await service.remove('c1', { userId: 'u1', email: 'x' });

        const calls = prisma.$queryRaw.mock.calls;
        const sql = calls.map(sqlOf);
        expect(calls.map((call: unknown[]) => call[1])).toEqual(['b1', 'v1', 'c1']);
        expect(sql[0]).toContain('FROM "Book" WHERE id = ? FOR KEY SHARE');
        expect(sql[1]).toContain('FROM "BookVersion" WHERE id = ? FOR KEY SHARE');
        expect(sql[2]).toContain('FROM "Comment" WHERE id = ? FOR UPDATE');
        // `ratingId` перечитан под замком: каскад обнулил его — оценку не трогаем (у стаба нет
        // `bookRating`, вызов по снимку до замка упал бы здесь же).
        expect(prisma.comment.update).toHaveBeenCalledTimes(1);
        expect(prisma.comment.update).toHaveBeenCalledWith({
          where: { id: 'c1' },
          data: { isDeleted: true },
        });
        expect(prisma.comment.updateMany).toHaveBeenCalledWith({
          where: { parentId: 'c1' },
          data: { isDeleted: true },
        });
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
          timeout: 30_000,
          maxWait: 10_000,
        });
      });

      it('книга отзыва стёрта встречным каскадом — снимать нечего, без записи и без 500', async () => {
        prisma.comment.findUnique.mockResolvedValueOnce({
          id: 'c1',
          isDeleted: false,
          userId: 'u1',
          ratingId: 'r1',
          bookVersionId: 'v1',
          rating: { bookId: 'b1' },
        });
        prisma.$queryRaw.mockResolvedValueOnce([]);

        await expect(service.remove('c1', { userId: 'u1', email: 'x' })).resolves.toBeUndefined();
        expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
        expect(prisma.comment.update).not.toHaveBeenCalled();
      });

      it('комментарий к главе: глава запирается раньше строки комментария', async () => {
        prisma.comment.findUnique.mockResolvedValueOnce({
          id: 'c1',
          isDeleted: false,
          userId: 'u1',
          chapterId: 'ch1',
        });
        prisma.$queryRaw
          .mockResolvedValueOnce([{ id: 'ch1' }])
          .mockResolvedValueOnce([{ isDeleted: false, ratingId: null }]);

        await service.remove('c1', { userId: 'u1', email: 'x' });

        const calls = prisma.$queryRaw.mock.calls;
        expect(calls.map((call: unknown[]) => call[1])).toEqual(['ch1', 'c1']);
        expect(sqlOf(calls[0] as unknown[])).toContain('FROM "Chapter" WHERE id = ? FOR KEY SHARE');
      });

      it('цель стёрта встречным каскадом — снимать нечего, без записи и без 500', async () => {
        prisma.comment.findUnique.mockResolvedValueOnce({
          id: 'c1',
          isDeleted: false,
          userId: 'u1',
          bookVersionId: 'v1',
        });
        prisma.$queryRaw.mockResolvedValueOnce([]);

        await expect(service.remove('c1', { userId: 'u1', email: 'x' })).resolves.toBeUndefined();
        expect(prisma.comment.update).not.toHaveBeenCalled();
      });

      it('комментарий стёрт или снят, пока ждали замок, — без записи', async () => {
        prisma.comment.findUnique.mockResolvedValueOnce({
          id: 'c1',
          isDeleted: false,
          userId: 'u1',
          bookVersionId: 'v1',
        });
        prisma.$queryRaw.mockResolvedValueOnce([{ id: 'v1' }]).mockResolvedValueOnce([]);

        await expect(service.remove('c1', { userId: 'u1', email: 'x' })).resolves.toBeUndefined();
        expect(prisma.comment.update).not.toHaveBeenCalled();
      });
    });
  });

  /**
   * `CommentDto.children` объявлен как `CommentDto[]`, где `user` обязателен.
   * Prisma отдаёт ровно то, что попросили, поэтому забытый `include` даёт
   * `children[].user === undefined` при зелёном typecheck — расхождение вылезет
   * обращением к `user.name` в рантайме (`LEGACY-102`).
   *
   * Проверяется каждый путь, возвращающий ветку, а не один: автор был потерян
   * именно потому, что `include` писался в четырёх местах по отдельности.
   */
  describe('вложенная ветка: автор и фильтр скрытых (LEGACY-102)', () => {
    beforeEach(() => {
      prisma.userRole.findMany.mockResolvedValue([]);
    });

    // Проверяются оба свойства ветки сразу и на каждом из четырёх путей.
    // Раздельная проверка — как в первой версии этих тестов, где фильтр
    // сверялся только у `get()`, — пропустила бы ровно ту регрессию, которую
    // код-ревью и нашло: `create` и `update` получили автора, но остались без
    // `where`, и скрытый ответ поехал бы с именем и аватаром.
    const childrenArgOf = (args: unknown) => {
      const include = (args as { include?: Record<string, unknown> } | undefined)?.include;
      return include?.children as
        | { where?: Record<string, unknown>; include?: Record<string, unknown> }
        | undefined;
    };

    const rootUserOf = (args: unknown) =>
      (args as { include?: { user?: unknown } } | undefined)?.include?.user;

    // Посадка LEGACY-211: до 15.08.2026 здесь проверялось только наличие ключа
    // `user`, и возврат к инлайн-литералу с почтой не красил в модуле
    // комментариев ничего — единственным сторожем публичной выдачи оставался
    // e2e `test/personal-data-leaks.e2e-spec.ts`, а он на обычном прогоне
    // не запускается.
    //
    // 🔴 Сравнение с константой её собственных расширений не заметит: допиши
    // в неё поле — поедут обе стороны сразу. Состав константы поэтому
    // проверяется отдельным тестом ниже.
    const AUTHOR = { select: PUBLIC_COMMENT_USER_SELECT };

    const expectAuthor = (children: ReturnType<typeof childrenArgOf>) =>
      expect(children?.include?.user).toEqual(AUTHOR);

    /** Автор корневого комментария — то же третье лицо, что и автор ответа. */
    const expectRootAuthor = (args: unknown) => expect(rootUserOf(args)).toEqual(AUTHOR);

    const VISIBLE_ONLY = { isDeleted: false, isHidden: false };
    const MODERATOR = { isDeleted: false };

    it('create() — автор есть, скрытые отфильтрованы', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce(undefined);
      prisma.bookVersion.findUnique.mockResolvedValueOnce({ id: 'v1' });
      prisma.comment.create.mockResolvedValueOnce({ id: 'c1' });

      await service.create('u1', { bookVersionId: 'v1', text: 'hi' } as CreateCommentDto);

      // Счётчик рядом с чтением `calls[0]`: без него второй запрос за тем же
      // комментарием, добавленный позже, в проверку не попадёт вовсе (`L-005`).
      expect(prisma.comment.create).toHaveBeenCalledTimes(1);
      const args = prisma.comment.create.mock.calls[0][0];
      const children = childrenArgOf(args);
      expectAuthor(children);
      expectRootAuthor(args);
      expect(children?.where).toEqual(VISIBLE_ONLY);
    });

    it('get() — автор есть, скрытые отфильтрованы', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1', isDeleted: false });

      await service.get('c1');

      expect(prisma.comment.findUnique).toHaveBeenCalledTimes(1);
      const args = prisma.comment.findUnique.mock.calls[0][0];
      const children = childrenArgOf(args);
      expectAuthor(children);
      expectRootAuthor(args);
      expect(children?.where).toEqual(VISIBLE_ONLY);
    });

    it('update() — автор есть, скрытые отфильтрованы для обычного пользователя', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({
        id: 'c1',
        userId: 'u1',
        isDeleted: false,
      });
      prisma.userRole.findMany.mockResolvedValueOnce([]);
      prisma.comment.update.mockResolvedValueOnce({ id: 'c1' });

      await service.update('c1', { userId: 'u1', email: 'u1@test.com' }, { text: 'edited' });

      expect(prisma.comment.update).toHaveBeenCalledTimes(1);
      const args = prisma.comment.update.mock.calls[0][0];
      const children = childrenArgOf(args);
      expectAuthor(children);
      expectRootAuthor(args);
      // 🔴 Регрессия, найденная ревью: без `where` здесь скрытый модератором
      // ответ возвращался бы автору корневого комментария вместе с личностью
      // того, кого скрыли.
      expect(children?.where).toEqual(VISIBLE_ONLY);
    });

    it('list() — автор есть, скрытые отфильтрованы', async () => {
      prisma.comment.findMany.mockResolvedValueOnce([]);
      prisma.comment.count.mockResolvedValueOnce(0);

      await service.list({ target: 'version', targetId: 'v1', page: 1, limit: 10 });

      expect(prisma.comment.findMany).toHaveBeenCalledTimes(1);
      const args = prisma.comment.findMany.mock.calls[0][0];
      const children = childrenArgOf(args);
      expectAuthor(children);
      expectRootAuthor(args);
      expect(children?.where).toEqual(VISIBLE_ONLY);
    });

    it('модератор видит скрытые ответы — иначе модерировать пришлось бы вслепую', async () => {
      prisma.comment.findUnique.mockResolvedValueOnce({ id: 'c1', isDeleted: false });
      prisma.userRole.findMany.mockResolvedValueOnce([{ role: { name: 'content_manager' } }]);

      await service.get('c1', { userId: 'm1', email: 'mod@test.com' });

      expect(prisma.comment.findUnique).toHaveBeenCalledTimes(1);
      const args = prisma.comment.findUnique.mock.calls[0][0];
      // Модератору расширяется видимость ветки, но не состав автора: почта
      // третьих лиц не показывается и ему — за ней есть свой маршрут
      // `GET /admin/comments` под `RolesGuard`.
      expectAuthor(childrenArgOf(args));
      expectRootAuthor(args);
      expect(childrenArgOf(args)?.where).toEqual(MODERATOR);
    });

    it('list(includeHidden) отдаёт скрытые — тот же признак, что и у корневых', async () => {
      prisma.comment.findMany.mockResolvedValueOnce([]);
      prisma.comment.count.mockResolvedValueOnce(0);

      await service.list({
        target: 'version',
        targetId: 'v1',
        page: 1,
        limit: 10,
        includeHidden: true,
      });

      expect(childrenArgOf(prisma.comment.findMany.mock.calls[0][0])?.where).toEqual(MODERATOR);
    });

    // Вторая половина посадки LEGACY-211: утверждения выше сравнивают аргумент
    // запроса с самой константой и её расширения не заметят.
    //
    // 🔴 Список ключей целиком, а не одно `not.toContain('email')`: список
    // белый, и опасна тут любая новая колонка схемы, а не только почта.
    // Отрицание на почту пропускало `lastLogin`, `firstName` и остальное —
    // правило обвязки `email:\s*true` их тоже не ловит.
    it('состав публичного селекта закреплён целиком (LEGACY-211)', () => {
      expect(Object.keys(PUBLIC_COMMENT_USER_SELECT)).toEqual([
        'id',
        'name',
        'nickname',
        'avatarUrl',
      ]);
    });
  });

  describe('list()', () => {
    it('applies hidden filter and target mapping with pagination', async () => {
      prisma.comment.findMany.mockResolvedValueOnce([{ id: 'c1' }]);
      prisma.comment.count.mockResolvedValueOnce(2);
      prisma.$transaction.mockImplementationOnce(async (arg) => {
        const ops = arg as Promise<unknown>[];
        const items = (await ops[0]) as unknown[];
        const total = (await ops[1]) as number;
        return [items, total];
      });
      const res = await service.list({ target: 'version', targetId: 'v1', page: 1, limit: 1 });
      expect(prisma.comment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isHidden: false,
            isDeleted: false,
            bookVersionId: 'v1',
          }),
          skip: 0,
          take: 1,
        }),
      );
      expect(res).toEqual({
        items: [{ id: 'c1', ratingScore: null }],
        pagination: { page: 1, limit: 1, total: 2, totalPages: 2, hasNext: true },
      });

      prisma.comment.findMany.mockClear();
      prisma.comment.findMany.mockResolvedValueOnce([]);
      prisma.comment.count.mockResolvedValueOnce(0);
      prisma.$transaction.mockImplementationOnce(async (arg) => {
        const ops = arg as Promise<unknown>[];
        const items = (await ops[0]) as unknown[];
        const total = (await ops[1]) as number;
        return [items, total];
      });
      await service.list({
        target: 'chapter',
        targetId: 'ch1',
        page: 1,
        limit: 10,
        includeHidden: true,
      });
      expect(prisma.comment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isDeleted: false, chapterId: 'ch1' }),
        }),
      );
    });

    it('supports sorting by popularity or date', async () => {
      prisma.comment.findMany.mockResolvedValueOnce([]);
      prisma.comment.count.mockResolvedValueOnce(0);
      prisma.$transaction.mockImplementation(() => {
        return Promise.resolve([[] as unknown[], 0]);
      });

      await service.list({
        target: 'version',
        targetId: 'v1',
        page: 1,
        limit: 10,
        sortBy: 'popularity',
      });
      expect(prisma.comment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { likes: { _count: 'desc' } },
        }),
      );

      await service.list({
        target: 'version',
        targetId: 'v1',
        page: 1,
        limit: 10,
        sortBy: 'date',
      });
      expect(prisma.comment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: 'desc' },
        }),
      );
    });
  });

  describe('create() with rating', () => {
    it('creates BookRating and links to comment when rating is provided', async () => {
      const bookVersion = { id: 'v1', bookId: 'b1' };
      prisma.bookVersion.findUnique.mockResolvedValueOnce(bookVersion);

      const ratingMock = { id: 'r1', score: 5 };
      const commentMock = { id: 'c1', text: 'great book', ratingId: 'r1', rating: ratingMock };

      // Mock tx functions
      const txMock = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: 'v1' }]),
        bookRating: {
          upsert: jest.fn().mockResolvedValueOnce(ratingMock),
        },
        comment: {
          findUnique: jest.fn().mockResolvedValueOnce(null),
          create: jest.fn().mockResolvedValueOnce(commentMock),
        },
      };

      prisma.$transaction.mockImplementationOnce((arg) => {
        const runInTransaction = arg as (tx: PrismaStub) => Promise<unknown>;
        return runInTransaction(txMock as unknown as PrismaStub);
      });

      const res = await service.create('u1', {
        bookVersionId: 'v1',
        text: 'great book',
        rating: 5,
      } as CreateCommentDto);

      expect(txMock.bookRating.upsert).toHaveBeenCalledWith({
        where: { userId_bookId: { userId: 'u1', bookId: 'b1' } },
        create: { userId: 'u1', bookId: 'b1', score: 5 },
        update: { score: 5 },
      });
      expect(res.ratingScore).toBe(5);
      expect(txMock.comment.findUnique).toHaveBeenCalledTimes(1);
      expect(txMock.comment.findUnique).toHaveBeenCalledWith({
        where: { ratingId: 'r1' },
        select: { id: true },
      });
    });

    // `LEGACY-435`: второй отзыв с оценкой на ту же книгу падал `P2002` и 500.
    it('оценка уже привязана к отзыву — 409, отзыв не создаётся', async () => {
      prisma.bookVersion.findUnique.mockResolvedValueOnce({ id: 'v1', bookId: 'b1' });
      const txMock = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: 'v1' }]),
        bookRating: { upsert: jest.fn().mockResolvedValueOnce({ id: 'r1', score: 2 }) },
        comment: {
          findUnique: jest.fn().mockResolvedValueOnce({ id: 'first' }),
          create: jest.fn(),
        },
      };
      prisma.$transaction.mockImplementationOnce((arg) => {
        const runInTransaction = arg as (tx: PrismaStub) => Promise<unknown>;
        return runInTransaction(txMock as unknown as PrismaStub);
      });

      await expect(
        service.create('u1', {
          bookVersionId: 'v1',
          text: 'second',
          rating: 2,
        } as CreateCommentDto),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(txMock.comment.create).not.toHaveBeenCalled();
      // Владелец ищется по связи с оценкой, а не по цели отзыва.
      expect(txMock.comment.findUnique).toHaveBeenCalledTimes(1);
      expect(txMock.comment.findUnique).toHaveBeenCalledWith({
        where: { ratingId: 'r1' },
        select: { id: true },
      });
      // Проверка после `upsert`: до него двойную отправку ничто не строит в очередь.
      expect(txMock.bookRating.upsert).toHaveBeenCalledTimes(1);
      expect(txMock.bookRating.upsert.mock.invocationCallOrder[0]).toBeLessThan(
        txMock.comment.findUnique.mock.invocationCallOrder[0],
      );
    });

    it('throws BadRequestException if rating is provided without bookVersionId', async () => {
      prisma.chapter.findUnique.mockResolvedValueOnce({ id: 'ch1' });
      await expect(
        service.create('u1', {
          chapterId: 'ch1',
          text: 'great book',
          rating: 5,
        } as CreateCommentDto),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

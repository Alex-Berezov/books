import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ModeratorRolesService } from '../../common/roles/moderator-roles.service';
import { PUBLIC_COMMENT_USER_SELECT } from '../../common/selects/public-comment-user.select';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCommentDto } from './dto/create-comment.dto';
import { UpdateCommentDto } from './dto/update-comment.dto';

/**
 * Вложенная ветка ответов: и кого показывать, и кто их написал.
 *
 * ⚠️ Одной функцией, и по той же причине, что и `PUBLIC_COMMENT_USER_SELECT`
 * (`src/common/selects/public-comment-user.select.ts`). `include` для ветки
 * писался в четырёх местах отдельно, и автор оказался только в одном из них
 * (`LEGACY-102`). Расхождение не ловится typecheck'ом: Prisma возвращает то, что
 * попросили, а `CommentDto` обещает `children: CommentDto[]` с обязательным
 * `user`, и поле приходит `undefined` там, где тип гарантирует объект.
 *
 * 🔴 **`where` входит сюда же, и это не удобство, а условие правильности.**
 * Первая версия правки вынесла в общую константу только `include`, оставив
 * фильтр дописываться по месту, — и два пути из четырёх (`create`, `update`)
 * остались без него. Результат был бы хуже исходного дефекта: скрытый
 * модератором ответ и раньше возвращался этими путями, но теперь приезжал бы
 * с именем и аватаром автора — ровно та выдача личности, которую закрывала
 * `LEGACY-089`. Общая часть обязана включать всё, что должно быть одинаковым,
 * иначе она даёт ложное чувство единообразия.
 *
 * Модератор скрытое видит: иначе модерировать пришлось бы вслепую.
 */
const commentChildren = (canModerate: boolean) => ({
  where: { isDeleted: false, ...(canModerate ? {} : { isHidden: false }) },
  include: { user: { select: PUBLIC_COMMENT_USER_SELECT } },
});

@Injectable()
export class CommentsService {
  constructor(
    private prisma: PrismaService,
    private readonly moderatorRoles: ModeratorRolesService,
  ) {}

  async list(params: {
    target: 'version' | 'chapter' | 'audio';
    targetId: string;
    page: number;
    limit: number;
    sortBy?: 'date' | 'popularity';
    includeHidden?: boolean;
  }) {
    const { target, targetId, page, limit, sortBy = 'date', includeHidden } = params;
    const whereBase: Prisma.CommentWhereInput = {
      isDeleted: false,
      parentId: null,
      ...(includeHidden ? {} : { isHidden: false }),
      ...(target === 'version' ? { bookVersionId: targetId } : {}),
      ...(target === 'chapter' ? { chapterId: targetId } : {}),
      ...(target === 'audio' ? { audioChapterId: targetId } : {}),
    };

    const orderBy: Prisma.CommentOrderByWithRelationInput =
      sortBy === 'popularity' ? { likes: { _count: 'desc' } } : { createdAt: 'desc' };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.comment.findMany({
        where: whereBase,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          // 🔴 До 10.08.2026 ответы фильтровались только по `isDeleted`: скрытый
          // модератором ответ оставался виден в публичном листинге, хотя
          // корневые комментарии он отсекал правильно. Сокрытие работало ровно
          // до первого ответа в ветке.
          children: commentChildren(includeHidden ?? false),
          rating: true,
          user: { select: PUBLIC_COMMENT_USER_SELECT },
        },
      }),
      this.prisma.comment.count({ where: whereBase }),
    ]);

    const mappedItems = items.map((item) => ({
      ...item,
      ratingScore: item.rating?.score || null,
    }));

    return { items: mappedItems, total, page, limit, hasNext: page * limit < total };
  }

  async create(userId: string, dto: CreateCommentDto) {
    if (dto.parentId) {
      const parent = await this.prisma.comment.findUnique({ where: { id: dto.parentId } });
      if (!parent || parent.isDeleted) {
        throw new NotFoundException('Parent comment not found');
      }
    }

    let bookId: string | undefined;
    if (dto.bookVersionId) {
      const exist = await this.prisma.bookVersion.findUnique({ where: { id: dto.bookVersionId } });
      if (!exist) throw new NotFoundException('BookVersion not found');
      bookId = exist.bookId;
    }
    if (dto.chapterId) {
      const exist = await this.prisma.chapter.findUnique({ where: { id: dto.chapterId } });
      if (!exist) throw new NotFoundException('Chapter not found');
    }
    if (dto.audioChapterId) {
      const exist = await this.prisma.audioChapter.findUnique({
        where: { id: dto.audioChapterId },
      });
      if (!exist) throw new NotFoundException('AudioChapter not found');
    }

    if (dto.rating) {
      if (!dto.bookVersionId) {
        throw new BadRequestException('Rating can only be attached to root book version comments');
      }
    }

    const comment = await this.prisma.$transaction(async (tx) => {
      let ratingId: string | undefined;

      if (dto.rating && bookId) {
        const rating = await tx.bookRating.upsert({
          where: {
            userId_bookId: { userId, bookId },
          },
          create: {
            userId,
            bookId,
            score: dto.rating,
          },
          update: {
            score: dto.rating,
          },
        });
        ratingId = rating.id;
      }

      return tx.comment.create({
        data: {
          userId,
          bookVersionId: dto.bookVersionId,
          chapterId: dto.chapterId,
          audioChapterId: dto.audioChapterId,
          parentId: dto.parentId,
          text: dto.text,
          ratingId,
        },
        include: {
          rating: true,
          user: { select: PUBLIC_COMMENT_USER_SELECT },
          // Автор ответа создаёт комментарий, а не модерирует: скрытые ответы
          // ему в выдаче не место.
          children: commentChildren(false),
        },
      });
    });

    return {
      ...comment,
      ratingScore: comment.rating?.score || null,
    };
  }

  /**
   * 🔴 Маршрут `GET /comments/:id` не проверял `isHidden`: скрытый модератором
   * комментарий читался по прямой ссылке, хотя из листинга исчезал
   * (`LEGACY-089`). Сокрытие держалось на том, что адрес трудно угадать, —
   * а он приходит в ответе на создание и лежит в истории браузера.
   *
   * Модератор скрытое видит: иначе модерировать пришлось бы вслепую, не имея
   * возможности перечитать то, что скрыл.
   */
  async get(id: string, actor?: { userId: string; email: string }) {
    const canModerate = actor ? await this.isModerator(actor.email, actor.userId) : false;

    const comment = await this.prisma.comment.findUnique({
      where: { id },
      include: {
        rating: true,
        user: { select: PUBLIC_COMMENT_USER_SELECT },
        children: commentChildren(canModerate),
      },
    });
    if (!comment || comment.isDeleted) {
      throw new NotFoundException('Comment not found');
    }
    if (comment.isHidden && !canModerate) {
      // 404, а не 403: существование скрытого комментария — тоже сведение.
      throw new NotFoundException('Comment not found');
    }
    return {
      ...comment,
      ratingScore: comment.rating?.score || null,
    };
  }

  async update(id: string, actor: { userId: string; email: string }, dto: UpdateCommentDto) {
    const existing = await this.prisma.comment.findUnique({
      where: { id },
      include: { rating: true },
    });
    if (!existing || existing.isDeleted) throw new NotFoundException('Comment not found');

    const canModerate = await this.isModerator(actor.email, actor.userId);
    const data: Prisma.CommentUpdateInput = {};
    if (dto.text !== undefined) {
      if (existing.userId !== actor.userId && !canModerate)
        throw new ForbiddenException('Not allowed to edit this comment');
      data.text = dto.text;
    }
    if (dto.isHidden !== undefined) {
      if (!canModerate) throw new ForbiddenException('Not allowed to moderate');
      data.isHidden = dto.isHidden;
    }
    if (Object.keys(data).length === 0) {
      return {
        ...existing,
        ratingScore: existing.rating?.score || null,
      };
    }

    const updated = await this.prisma.comment.update({
      where: { id },
      data,
      include: {
        rating: true,
        user: { select: PUBLIC_COMMENT_USER_SELECT },
        children: commentChildren(canModerate),
      },
    });

    return {
      ...updated,
      ratingScore: updated.rating?.score || null,
    };
  }

  /**
   * Плоский список всех комментариев для модерации (`LEGACY-092`).
   *
   * 🔴 До 10.08.2026 такого маршрута не существовало вовсе, а админский раздел
   * фронта был написан так, будто он есть: звал `GET /comments?page=…` (400,
   * потому что публичный листинг требует `target` и `targetId`) и два адреса,
   * которых нет. Модерация отзывов не работала в принципе.
   *
   * ⚠️ Публичный `list()` для этого не годится и не должен: он отвечает на
   * вопрос «что показать под этой книгой», а модерации нужен вопрос «что вообще
   * написали на сайте». Разные вопросы — разные запросы; попытка обслужить оба
   * одним привела бы к тому же, что `LEGACY-093`.
   */
  async adminList(params: {
    page: number;
    limit: number;
    search?: string;
    status?: 'visible' | 'hidden' | 'all';
    bookId?: string;
  }) {
    const { page, limit, search, status = 'all', bookId } = params;

    const where: Prisma.CommentWhereInput = {
      isDeleted: false,
      ...(status === 'visible' ? { isHidden: false } : {}),
      ...(status === 'hidden' ? { isHidden: true } : {}),
      ...(bookId ? { bookVersion: { bookId } } : {}),
      ...(search
        ? {
            OR: [
              { text: { contains: search, mode: 'insensitive' as const } },
              { user: { name: { contains: search, mode: 'insensitive' as const } } },
              { user: { nickname: { contains: search, mode: 'insensitive' as const } } },
              { user: { email: { contains: search, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.comment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          text: true,
          isHidden: true,
          createdAt: true,
          parentId: true,
          bookVersionId: true,
          user: { select: { id: true, name: true, nickname: true, email: true, avatarUrl: true } },
          bookVersion: { select: { title: true, bookId: true } },
          _count: { select: { children: true } },
        },
      }),
      this.prisma.comment.count({ where }),
    ]);

    return {
      data: items.map((item) => ({
        id: item.id,
        text: item.text,
        isHidden: item.isHidden,
        createdAt: item.createdAt,
        author: item.user,
        bookTitle: item.bookVersion?.title ?? null,
        bookId: item.bookVersion?.bookId ?? null,
        bookVersionId: item.bookVersionId,
        parentId: item.parentId,
        repliesCount: item._count.children,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // Та же проверка нужна `book-summary`, поэтому логика переехала в
  // `ModeratorRolesService` (10.08.2026). Здесь остался тонкий адаптер под
  // порядок аргументов, принятый в этом сервисе.
  private isModerator(email: string, userId: string): Promise<boolean> {
    return this.moderatorRoles.isModerator({ userId, email });
  }

  async moderate(id: string, isHidden: boolean, actor: { userId: string; email: string }) {
    return this.update(id, actor, { isHidden });
  }

  async remove(id: string, actor: { userId: string; email: string }) {
    const existing = await this.prisma.comment.findUnique({ where: { id } });
    if (!existing || existing.isDeleted) return; // idempotent
    if (existing.userId !== actor.userId) {
      const can = await this.isModerator(actor.email, actor.userId);
      if (!can) throw new ForbiddenException('Not allowed to delete this comment');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.comment.update({ where: { id }, data: { isDeleted: true } });
      await tx.comment.updateMany({ where: { parentId: id }, data: { isDeleted: true } });
      if (existing.ratingId) {
        await tx.bookRating.delete({ where: { id: existing.ratingId } });
      }
    });
  }
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export const ADMIN_COMMENTS_MAX_LIMIT = 100;

/**
 * ⚠️ Потолок `limit` задан сразу. Админские списки без потолка в этом проекте
 * уже встречались (`LEGACY-076`), и добавить его позже дороже: к моменту
 * добавления на маршруте успевают появиться потребители, просящие `limit=1000`.
 */
export class AdminCommentsQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: ADMIN_COMMENTS_MAX_LIMIT, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ADMIN_COMMENTS_MAX_LIMIT)
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'Substring of the comment text, author name or e-mail' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: ['visible', 'hidden', 'all'], default: 'all' })
  @IsOptional()
  @IsIn(['visible', 'hidden', 'all'])
  status?: 'visible' | 'hidden' | 'all' = 'all';

  @ApiPropertyOptional({ description: 'Limit to comments on a single book' })
  @IsOptional()
  @IsUUID()
  bookId?: string;
}

export class AdminCommentAuthorDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String, nullable: true, required: false })
  name?: string | null;

  @ApiProperty({ type: String, nullable: true, required: false })
  nickname?: string | null;

  /**
   * Почта здесь **уместна**, в отличие от публичной выдачи (`LEGACY-089`):
   * маршрут закрыт гвардом, а модератору нужно отличать однофамильцев и
   * находить повторных нарушителей.
   */
  @ApiProperty({ type: String })
  email!: string;

  @ApiProperty({ type: String, nullable: true, required: false })
  avatarUrl?: string | null;
}

export class AdminCommentDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  text!: string;

  @ApiProperty({ type: Boolean })
  isHidden!: boolean;

  @ApiProperty({ type: Date })
  createdAt!: Date;

  @ApiProperty({ type: AdminCommentAuthorDto })
  author!: AdminCommentAuthorDto;

  @ApiProperty({ type: String, nullable: true, required: false })
  bookTitle!: string | null;

  @ApiProperty({ type: String, nullable: true, required: false })
  bookId!: string | null;

  /**
   * Нужен, чтобы ответить на комментарий: `POST /comments` требует цель, а не
   * только `parentId`.
   */
  @ApiProperty({ type: String, nullable: true, required: false })
  bookVersionId!: string | null;

  @ApiProperty({ type: String, nullable: true, required: false })
  parentId!: string | null;

  @ApiProperty({ type: Number })
  repliesCount!: number;
}

/**
 * Страница выдачи модерации — та же четвёрка, что собирает `comments.service.ts`
 * в `adminList()` (блок `meta`, строки 319-324).
 *
 * 🔴 Отдельный класс, а не встроенный литерал у поля. Плагина swagger в проекте нет
 * (`nest-cli.json` без `plugins`), схема строится только из декораторов: `@ApiProperty()`
 * над полем с типом-литералом даёт в OpenAPI голый `type: object` без единого свойства.
 * `CommentsList.tsx` на фронте читает `meta.totalPages`, а рукописный тип сверяется
 * со схемой машинно (`yarn check:type-sync`) — пустой объект в схеме толкает фронт
 * удалить верное поле из своего типа (`LEGACY-374`).
 */
export class AdminCommentsMetaDto {
  @ApiProperty({ type: Number, example: 1 })
  page!: number;

  @ApiProperty({ type: Number, example: 20 })
  limit!: number;

  @ApiProperty({ type: Number, example: 45 })
  total!: number;

  @ApiProperty({ type: Number, description: 'Math.ceil(total / limit)', example: 3 })
  totalPages!: number;
}

export class AdminCommentsResponseDto {
  @ApiProperty({ type: [AdminCommentDto] })
  data!: AdminCommentDto[];

  @ApiProperty({ type: AdminCommentsMetaDto })
  meta!: AdminCommentsMetaDto;
}

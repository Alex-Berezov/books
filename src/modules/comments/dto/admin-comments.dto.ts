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
  @ApiProperty()
  id!: string;

  @ApiProperty({ required: false, nullable: true })
  name?: string | null;

  @ApiProperty({ required: false, nullable: true })
  nickname?: string | null;

  /**
   * Почта здесь **уместна**, в отличие от публичной выдачи (`LEGACY-089`):
   * маршрут закрыт гвардом, а модератору нужно отличать однофамильцев и
   * находить повторных нарушителей.
   */
  @ApiProperty()
  email!: string;

  @ApiProperty({ required: false, nullable: true })
  avatarUrl?: string | null;
}

export class AdminCommentDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  text!: string;

  @ApiProperty()
  isHidden!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({ type: AdminCommentAuthorDto })
  author!: AdminCommentAuthorDto;

  @ApiProperty({ required: false, nullable: true })
  bookTitle!: string | null;

  @ApiProperty({ required: false, nullable: true })
  bookId!: string | null;

  /**
   * Нужен, чтобы ответить на комментарий: `POST /comments` требует цель, а не
   * только `parentId`.
   */
  @ApiProperty({ required: false, nullable: true })
  bookVersionId!: string | null;

  @ApiProperty({ required: false, nullable: true })
  parentId!: string | null;

  @ApiProperty()
  repliesCount!: number;
}

export class AdminCommentsResponseDto {
  @ApiProperty({ type: [AdminCommentDto] })
  data!: AdminCommentDto[];

  @ApiProperty()
  meta!: { page: number; limit: number; total: number; totalPages: number };
}

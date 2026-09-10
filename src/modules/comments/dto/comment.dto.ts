import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { CommentUserDto } from './comment-user.dto';

export class CommentDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'Автор комментария; публичный профиль лежит в `user`' })
  userId!: string;

  @ApiProperty({ type: String, nullable: true })
  parentId?: string | null;

  @ApiProperty({ type: String, nullable: true })
  bookVersionId?: string | null;

  @ApiProperty({ type: String, nullable: true })
  chapterId?: string | null;

  @ApiProperty({ type: String, nullable: true })
  audioChapterId?: string | null;

  @ApiProperty({ type: String, nullable: true })
  ratingId?: string | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Rating score associated with this review (1-5)',
  })
  ratingScore?: number | null;

  @ApiProperty()
  text!: string;

  @ApiProperty()
  isHidden!: boolean;

  @ApiProperty()
  isDeleted!: boolean;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;

  @ApiProperty({ type: CommentUserDto })
  user!: CommentUserDto;

  @ApiProperty({ type: () => [CommentDto] })
  children!: CommentDto[];
}

// Связь `rating` выбирается у КОРНЕВЫХ комментариев — и в `list()`, и в `create()`, и в `get()`,
// и в `update()` (`comments.service.ts`, везде `include: { rating: true }`). Отдельный класс
// нужен потому, что у вложенных `children` эта связь не выбирается (`commentChildren` берёт
// только `user`): описать `rating` прямо в CommentDto значило бы обещать его и в ветке ответов.
export class CommentRatingDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  userId!: string;

  @ApiProperty()
  bookId!: string;

  @ApiProperty({ description: 'Оценка книги, 1-5' })
  score!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

export class CommentDetailDto extends CommentDto {
  @ApiProperty({ type: CommentRatingDto, nullable: true })
  rating!: CommentRatingDto | null;
}

/**
 * `PATCH /comments/:id` с пустым `dto` (ни `text`, ни `isHidden`) не трогает `data` и не
 * перечитывает связи — ветка `Object.keys(data).length === 0` в `comments.service.ts` отдаёт
 * текущую запись как есть, без `user` и `children`, которые есть в остальных ответах модуля.
 * Настоящий union двух форм, а не недосмотр — задокументирован через `oneOf` в контроллере.
 */
export class CommentBareDto extends OmitType(CommentDetailDto, ['user', 'children'] as const) {}

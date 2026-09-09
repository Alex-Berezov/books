import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CommentUserDto } from './comment-user.dto';

export class CommentDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'Автор комментария; публичный профиль лежит в `user`' })
  userId!: string;

  @ApiProperty({ nullable: true })
  parentId?: string | null;

  @ApiProperty({ nullable: true })
  bookVersionId?: string | null;

  @ApiProperty({ nullable: true })
  chapterId?: string | null;

  @ApiProperty({ nullable: true })
  audioChapterId?: string | null;

  @ApiProperty({ nullable: true })
  ratingId?: string | null;

  @ApiPropertyOptional({
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

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class CommentDetailDto extends CommentDto {
  @ApiProperty({ type: CommentRatingDto, nullable: true })
  rating!: CommentRatingDto | null;
}

import { ApiProperty } from '@nestjs/swagger';
import { UserActivityDto } from './user-activity.dto';

/**
 * Ответ `GET /users/me/activities`. Форма обёртки — `{items,total,page,limit,hasNext}`,
 * та же, что у `CommentListDto` (`comments/dto/comment-list.dto.ts`): страница
 * собирается тем же приёмом ($transaction findMany+count), и `books-front`
 * уже умеет читать эту форму («load more» в `BookReviews.tsx`).
 */
export class PagedUserActivitiesDto {
  @ApiProperty({ type: UserActivityDto, isArray: true })
  items!: UserActivityDto[];

  @ApiProperty({ type: Number })
  total!: number;

  @ApiProperty({ type: Number })
  page!: number;

  @ApiProperty({ type: Number })
  limit!: number;

  @ApiProperty({ type: Boolean })
  hasNext!: boolean;
}

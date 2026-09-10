import { ApiProperty } from '@nestjs/swagger';
import { CommentDetailDto } from './comment.dto';

export class CommentListDto {
  // Элементы списка несут связь `rating` целиком: `comments.service.ts` в `list()` выбирает
  // её через `include: { rating: true }`, как и одиночные ручки. До 09.09.2026 здесь стоял
  // CommentDto без неё, и схема списка была беднее ответа.
  @ApiProperty({ type: [CommentDetailDto] })
  items!: CommentDetailDto[];

  @ApiProperty({ type: Number })
  total!: number;

  @ApiProperty({ type: Number })
  page!: number;

  @ApiProperty({ type: Number })
  limit!: number;

  @ApiProperty({ type: Boolean })
  hasNext!: boolean;
}

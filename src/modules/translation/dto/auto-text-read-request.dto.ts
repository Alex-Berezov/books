import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601 } from 'class-validator';

/**
 * Тело «Mark as read» (`T184`): время последнего текста модели, который редактор видел на вкладке.
 * Под замком строки оно сверяется с текущим: текст, легший после показа вкладки, отметкой не
 * покрывается (409 `AUTO_TEXT_CHANGED`).
 */
export class MarkAutoTextReadDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'autoTextAt the editor saw (from GET .../read); another one - 409 AUTO_TEXT_CHANGED',
  })
  @IsISO8601({ strict: true })
  autoTextAt!: string;
}

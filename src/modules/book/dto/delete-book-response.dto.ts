import { ApiProperty } from '@nestjs/swagger';

/**
 * Ответ `DELETE /books/:id`. Маршрут отвечает **200 с телом**, а не 204: `@HttpCode` у него нет,
 * и контроллер собирает объект сам (`book.controller.ts`), выбрасывая удалённую запись, которую
 * вернул сервис. Форма описана, потому что тело действительно уезжает клиенту — в отличие
 * от соседних `DELETE` под 204, где Express обнуляет его на транспорте
 * (`LEGACY-373`, 14.09.2026).
 */
export class DeleteBookResponseDto {
  @ApiProperty({ type: Boolean, description: 'Книга удалена' })
  success!: boolean;
}

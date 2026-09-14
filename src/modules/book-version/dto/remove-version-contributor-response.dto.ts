import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Ответ `DELETE /admin/versions/:id/contributors/:contributorId`. Маршрут отвечает **200
 * с телом** (`@HttpCode` у него нет), и `warning` — единственное место, где оператору
 * сообщается, что снят основной `AUTHOR` и у версии не осталось ни одного автора, тогда
 * как унаследованная строка `BookVersion.author` не изменилась
 * (`book-version.service.ts: removeVersionContributor`).
 *
 * Поле необязательное по факту: сервис кладёт его только в этой ветке. Сводить маршрут
 * к 204 нельзя — предупреждение исчезло бы вместе с телом (`LEGACY-373`, 14.09.2026).
 */
export class RemoveVersionContributorResponseDto {
  @ApiProperty({ type: Boolean, description: 'Связь с контрибьютором снята' })
  success!: boolean;

  @ApiPropertyOptional({
    type: String,
    description:
      'Предупреждение: снят основной AUTHOR и авторов у версии не осталось. ' +
      'Приходит только в этой ветке.',
  })
  warning?: string;
}

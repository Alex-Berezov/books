import { ApiProperty } from '@nestjs/swagger';

/**
 * Ответ `DELETE /media/:id`. Маршрут отвечает **200 с телом** (`@HttpCode` у него нет),
 * и тело несёт единственный сигнал о расхождении базы с хранилищем: `storageDeleted: false`
 * означает, что запись помечена удалённой, а объект в хранилище остался сиротой и снимается
 * руками (`media.service.ts`, `LEGACY-058`). Поэтому форма описывается, а не сводится к 204:
 * ответ без этого поля потерял бы предупреждение целиком (`LEGACY-373`, 14.09.2026).
 */
export class DeleteMediaResponseDto {
  @ApiProperty({ type: Boolean, description: 'Запись помечена удалённой' })
  success!: boolean;

  @ApiProperty({
    type: Boolean,
    description:
      'Объект удалён и из хранилища. `false` — запись удалена, а объект остался сиротой ' +
      'и требует ручной уборки.',
  })
  storageDeleted!: boolean;
}

import { ApiProperty } from '@nestjs/swagger';

/** Ограничения одного вида загрузки. Оба поля читаются из окружения при старте сервиса. */
export class UploadKindLimitsDto {
  @ApiProperty({ description: 'Максимальный размер файла в мегабайтах', example: 5 })
  maxSizeMb!: number;

  @ApiProperty({ type: String, isArray: true, example: ['image/jpeg', 'image/png'] })
  allowedContentTypes!: string[];
}

/**
 * Ответ `GET /uploads/limits` — то, что собирает `UploadsService.getLimits()`.
 * Маршрут публичный (гвардов на нём нет), поэтому наружу идут только пределы,
 * без настроек драйвера хранилища.
 */
export class UploadLimitsDto {
  @ApiProperty({ type: UploadKindLimitsDto })
  image!: UploadKindLimitsDto;

  @ApiProperty({ type: UploadKindLimitsDto })
  audio!: UploadKindLimitsDto;

  @ApiProperty({ description: 'Срок жизни подписи прямой загрузки в секундах', example: 600 })
  presignTtlSec!: number;
}

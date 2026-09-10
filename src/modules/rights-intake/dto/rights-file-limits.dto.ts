import { ApiProperty } from '@nestjs/swagger';

/**
 * Разрешённые content-type по видам юридических файлов. Списки читаются из окружения
 * (`RIGHTS_FILES_ALLOWED_*_CT`) при каждом вызове, поэтому фиксированного enum здесь нет.
 */
export class RightsFileAllowedContentTypesDto {
  @ApiProperty({ type: String, isArray: true, example: ['application/pdf'] })
  reportPdf!: string[];

  @ApiProperty({
    type: String,
    isArray: true,
    example: ['application/pdf', 'application/epub+zip', 'text/plain'],
  })
  sourceFile!: string[];

  @ApiProperty({
    type: String,
    isArray: true,
    example: ['application/pdf', 'image/png', 'image/jpeg'],
  })
  evidence!: string[];
}

/**
 * Ответ `GET /admin/rights/files/limits` — то, что отдаёт
 * `RightsFileStorageService.getLimits()` через `RightsFilesService.getLimits()`.
 */
export class RightsFileLimitsDto {
  @ApiProperty({
    type: Number,
    description: 'Максимальный размер загружаемого файла в мегабайтах',
    example: 25,
  })
  maxSizeMb!: number;

  @ApiProperty({ type: RightsFileAllowedContentTypesDto })
  allowedContentTypes!: RightsFileAllowedContentTypesDto;
}

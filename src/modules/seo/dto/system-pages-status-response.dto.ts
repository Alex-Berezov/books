import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 * Форма зеркалит `SystemPageState`/`SystemPagesStatus`
 * (`src/modules/seo/system-pages/system-pages.service.ts`) один в один.
 */
export class SystemPageSlugsDto {
  @ApiPropertyOptional()
  en?: string;

  @ApiPropertyOptional()
  es?: string;

  @ApiPropertyOptional()
  fr?: string;

  @ApiPropertyOptional()
  pt?: string;

  @ApiPropertyOptional()
  ru?: string;
}

export class SystemPageStateDto {
  @ApiProperty()
  systemKey!: string;

  @ApiProperty()
  purpose!: string;

  @ApiProperty({ enum: Language, isArray: true })
  publishedIn!: Language[];

  @ApiProperty({ enum: Language, isArray: true })
  draftIn!: Language[];

  @ApiProperty({ enum: Language, isArray: true })
  missingIn!: Language[];

  @ApiProperty({
    type: SystemPageSlugsDto,
    description: 'Публичный слаг страницы по языку — только для чтения человеком.',
  })
  slugs!: SystemPageSlugsDto;
}

export class SystemPagesStatusResponseDto {
  @ApiProperty()
  ok!: boolean;

  @ApiProperty()
  checkedAt!: string;

  @ApiProperty({ enum: Language, isArray: true })
  expectedLanguages!: Language[];

  @ApiProperty({ type: SystemPageStateDto, isArray: true })
  pages!: SystemPageStateDto[];

  @ApiProperty({ type: SystemPageStateDto, isArray: true })
  problems!: SystemPageStateDto[];

  @ApiPropertyOptional({
    description: 'Заполнено только если сама проверка не смогла выполниться.',
  })
  error?: string;
}

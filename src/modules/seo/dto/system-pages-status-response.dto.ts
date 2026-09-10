import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 * Форма зеркалит `SystemPageState`/`SystemPagesStatus`
 * (`src/modules/seo/system-pages/system-pages.service.ts`) один в один.
 */
export class SystemPageSlugsDto {
  @ApiPropertyOptional({ type: String })
  en?: string;

  @ApiPropertyOptional({ type: String })
  es?: string;

  @ApiPropertyOptional({ type: String })
  fr?: string;

  @ApiPropertyOptional({ type: String })
  pt?: string;

  @ApiPropertyOptional({ type: String })
  ru?: string;
}

export class SystemPageStateDto {
  @ApiProperty({ type: String })
  systemKey!: string;

  @ApiProperty({ type: String })
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
  @ApiProperty({ type: Boolean })
  ok!: boolean;

  @ApiProperty({ type: String })
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

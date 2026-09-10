import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FaqItemDto } from '../../../shared/dto/faq-item.dto';
import { Language } from '@prisma/client';
import { SeoResponseDto } from '../../seo/dto/seo-response.dto';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 * Поля зеркалят модель `CategoryTranslation` (`prisma/schema.prisma`) один
 * в один, плюс раскрытая связь `seo` (обе ручки читают её через
 * `include: { seo: true }`).
 *
 * Используется на `POST /categories/:id/translations` и
 * `PATCH /categories/:id/translations/:language` — `CategoryService`
 * возвращает в обоих местах запись перевода целиком, без выборки полей.
 */
export class CategoryTranslationEntityDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  categoryId!: string;

  @ApiProperty({ enum: Language })
  language!: Language;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: String })
  slug!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  description?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  h1?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  shortDescription?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  metaTitle?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  metaDescription?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  ogTitle?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  ogDescription?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  ogImageUrl?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  ogImageAlt?: string | null;

  @ApiPropertyOptional({
    type: [FaqItemDto],
    nullable: true,
    description:
      'Json column. Shape held by `@IsArray() @IsObject({ each: true })` on `CreateCategoryTranslationDto.faq`.',
    example: [{ question: 'What is this?', answer: 'This is...' }],
  })
  faq?: FaqItemDto[] | null;

  @ApiProperty({ type: Number, default: 0 })
  bookCount!: number;

  @ApiProperty({ type: Boolean, default: true })
  autoIndexable!: boolean;

  @ApiPropertyOptional({ type: Number, nullable: true })
  seoId?: number | null;

  @ApiPropertyOptional({ type: SeoResponseDto, nullable: true })
  seo?: SeoResponseDto | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  ValidateNested,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  SLUG_PATTERN,
  SLUG_REGEX_README,
  SLUG_MAX_LENGTH,
  SLUG_MAX_LENGTH_MESSAGE,
} from '../../../shared/validators/slug';
import { IsAbsoluteHttpUrl } from '../../../shared/validators/absolute-http-url.decorator';
import { SeoInputDto } from '../../pages/dto/seo-input.dto';
import { RICH_HTML_MAX_LENGTH, RichHtml } from '../../../shared/validators/rich-html.decorator';
import { FaqItemDto } from '../../../shared/dto/faq-item.dto';

export class CreateCategoryTranslationDto {
  @ApiProperty({ enum: Object.values(Language) })
  @IsEnum(Language)
  language!: Language;

  @ApiProperty({ description: 'Localized category name' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({
    description: 'Localized category slug',
    pattern: SLUG_PATTERN,
    maxLength: SLUG_MAX_LENGTH,
  })
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  @MaxLength(SLUG_MAX_LENGTH, { message: SLUG_MAX_LENGTH_MESSAGE })
  slug!: string;

  @ApiPropertyOptional({ description: 'HTML description for the category page' })
  @IsOptional()
  @IsString()
  @RichHtml(RICH_HTML_MAX_LENGTH.text)
  description?: string | null;

  @ApiPropertyOptional({ description: 'H1 heading for the page', type: String, nullable: true })
  @IsOptional()
  @IsString()
  h1?: string | null;

  @ApiPropertyOptional({ description: 'Short description for cards/lists' })
  @IsOptional()
  @IsString()
  shortDescription?: string;

  @ApiPropertyOptional({ description: 'Meta title for SEO', type: String, nullable: true })
  @IsOptional()
  @IsString()
  metaTitle?: string | null;

  @ApiPropertyOptional({ description: 'Meta description for SEO' })
  @IsOptional()
  @IsString()
  metaDescription?: string;

  @ApiPropertyOptional({ description: 'Open Graph title', type: String, nullable: true })
  @IsOptional()
  @IsString()
  ogTitle?: string | null;

  @ApiPropertyOptional({ description: 'Open Graph description' })
  @IsOptional()
  @IsString()
  ogDescription?: string;

  @ApiPropertyOptional({ description: 'Open Graph image URL' })
  @IsOptional()
  @IsAbsoluteHttpUrl()
  ogImageUrl?: string;

  @ApiPropertyOptional({ description: 'Open Graph image alt text', type: String, nullable: true })
  @IsOptional()
  @IsString()
  ogImageAlt?: string | null;

  @ApiPropertyOptional({
    description: 'FAQ items as JSON array',
    type: [FaqItemDto],
    nullable: true,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FaqItemDto)
  faq?: FaqItemDto[] | null;

  @ApiPropertyOptional({ description: 'SEO metadata', type: SeoInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SeoInputDto)
  seo?: SeoInputDto;
}

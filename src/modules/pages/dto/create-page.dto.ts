import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  ValidateNested,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';
import { FaqItemDto } from '../../../shared/dto/faq-item.dto';
import { SeoInputDto } from './seo-input.dto';
import { SHORT_TEXT_MAX_LENGTH } from '../../../shared/constants/validation';
import { RICH_HTML_MAX_LENGTH, RichHtml } from '../../../shared/validators/rich-html.decorator';

export class CreatePageDto {
  @ApiProperty({ description: 'Page slug', pattern: SLUG_PATTERN })
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  slug!: string;

  @ApiProperty({ description: 'Page title' })
  @IsString()
  @MinLength(2)
  title!: string;

  @ApiProperty({ enum: ['generic', 'category_index', 'author_index', 'homepage'] })
  @IsIn(['generic', 'category_index', 'author_index', 'homepage'])
  type!: 'generic' | 'category_index' | 'author_index' | 'homepage';

  @ApiProperty({ description: 'Page content (markdown/HTML/text)' })
  @IsString()
  @RichHtml(RICH_HTML_MAX_LENGTH.body)
  content!: string;

  @ApiPropertyOptional({ description: 'SEO H1 heading (overrides title for display purposes)' })
  @IsOptional()
  @IsString()
  h1?: string;

  @ApiPropertyOptional({ description: 'Short description for overview cards/previews' })
  @IsOptional()
  @IsString()
  @MaxLength(SHORT_TEXT_MAX_LENGTH)
  shortDescription?: string;

  @ApiPropertyOptional({
    description: 'FAQ structured data as JSON array of {question, answer}',
    type: [FaqItemDto],
  })
  @IsOptional()
  @IsArray()
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => FaqItemDto)
  faq?: FaqItemDto[];

  // Note: language for admin endpoints is derived from admin context (/:lang or X-Admin-Language)
  // The field remains optional for backward compatibility, but the controller ignores it.
  @ApiProperty({ enum: ['en', 'es', 'fr', 'pt', 'ru'], required: false })
  @IsOptional()
  @IsIn(['en', 'es', 'fr', 'pt', 'ru'])
  language?: 'en' | 'es' | 'fr' | 'pt' | 'ru';

  @ApiPropertyOptional({
    description: 'SEO entity ID (legacy, use seo instead)',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  seoId?: number | null;

  @ApiPropertyOptional({
    description: 'SEO data (automatically creates the SEO entity)',
    type: SeoInputDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => SeoInputDto)
  seo?: SeoInputDto;

  @ApiPropertyOptional({
    description: 'Homepage sections configuration (JSON object with block data)',
  })
  @IsOptional()
  @IsObject()
  sections?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Translation Group ID (UUID) to link translations' })
  @IsOptional()
  @IsUUID()
  translationGroupId?: string;
}

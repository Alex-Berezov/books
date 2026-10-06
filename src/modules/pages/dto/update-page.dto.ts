import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  ValidateIf,
  ValidateNested,
  MaxLength,
} from 'class-validator';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';
import { FaqItemDto } from '../../../shared/dto/faq-item.dto';
import { SeoInputDto } from './seo-input.dto';
import { SHORT_TEXT_MAX_LENGTH } from '../../../shared/constants/validation';
import { RICH_HTML_MAX_LENGTH, RichHtml } from '../../../shared/validators/rich-html.decorator';

export class UpdatePageDto {
  @ApiPropertyOptional({ description: 'Page slug', pattern: SLUG_PATTERN })
  // `LEGACY-437`: `null` в `Page.slug` NOT NULL — 500; пропускается только отсутствующее поле.
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  slug?: string;

  @ApiPropertyOptional({ description: 'Page title' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  title?: string;

  @ApiPropertyOptional({ enum: ['generic', 'category_index', 'author_index', 'homepage'] })
  @IsOptional()
  @IsIn(['generic', 'category_index', 'author_index', 'homepage'])
  type?: 'generic' | 'category_index' | 'author_index' | 'homepage';

  @ApiPropertyOptional({ description: 'Page content (markdown/HTML/text)' })
  @IsOptional()
  @IsString()
  @RichHtml(RICH_HTML_MAX_LENGTH.body)
  content?: string;

  @ApiPropertyOptional({
    description: 'SEO H1 heading (overrides title for display purposes)',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  h1?: string | null;

  @ApiPropertyOptional({
    description: 'Short description for overview cards/previews',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(SHORT_TEXT_MAX_LENGTH)
  shortDescription?: string | null;

  @ApiPropertyOptional({
    description: 'FAQ structured data as JSON array of {question, answer}',
    nullable: true,
    type: [FaqItemDto],
  })
  @IsOptional()
  @IsArray()
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => FaqItemDto)
  faq?: FaqItemDto[] | null;

  @ApiPropertyOptional({
    enum: ['en', 'es', 'fr', 'pt', 'ru'],
    description:
      'Immutable after creation: only the current language (or null) is accepted; any other value is rejected with 400. Create a translation instead.',
  })
  @IsOptional()
  @IsIn(['en', 'es', 'fr', 'pt', 'ru'])
  language?: 'en' | 'es' | 'fr' | 'pt' | 'ru';

  @ApiPropertyOptional({
    description:
      'Legacy: attach an existing SEO entity by ID. Applies when `seo` is omitted; when `seo` is sent, the page writes its own SEO entity (or detaches it if all `seo` fields are empty) and `seoId` should not be sent. A new SEO entity already attached to another entity is rejected with 400. The SEO entity the page is detached from (explicit null, replaced here, or all `seo` fields empty) is deleted when no other entity uses it.',
    nullable: true,
  })
  @IsOptional()
  @Type(() => Number)
  seoId?: number | null;

  @ApiPropertyOptional({
    description: 'SEO data (automatically creates/updates the SEO entity)',
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

  @ApiPropertyOptional({ description: 'Publication status', enum: ['draft', 'published'] })
  @IsOptional()
  @IsIn(['draft', 'published'])
  status?: 'draft' | 'published';
}

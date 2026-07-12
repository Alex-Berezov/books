import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MinLength, ValidateNested } from 'class-validator';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';
import { SeoInputDto } from './seo-input.dto';

export class UpdatePageDto {
  @ApiPropertyOptional({ description: 'Page slug', pattern: SLUG_PATTERN })
  @IsOptional()
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
  shortDescription?: string | null;

  @ApiPropertyOptional({
    description: 'FAQ structured data as JSON array of {question, answer}',
    nullable: true,
  })
  @IsOptional()
  faq?: Array<{ question: string; answer: string }> | null;

  @ApiPropertyOptional({ enum: ['en', 'es', 'fr', 'pt', 'ru'] })
  @IsOptional()
  @IsIn(['en', 'es', 'fr', 'pt', 'ru'])
  language?: 'en' | 'es' | 'fr' | 'pt' | 'ru';

  @ApiPropertyOptional({ description: 'SEO entity ID', nullable: true })
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
  sections?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Publication status', enum: ['draft', 'published'] })
  @IsOptional()
  @IsIn(['draft', 'published'])
  status?: 'draft' | 'published';
}

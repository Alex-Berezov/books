import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MinLength, ValidateNested } from 'class-validator';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';
import { SeoInputDto } from './seo-input.dto';

export class CreatePageDto {
  @ApiProperty({ description: 'Page slug', pattern: SLUG_PATTERN })
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  slug!: string;

  @ApiProperty({ description: 'Page title' })
  @IsString()
  @MinLength(2)
  title!: string;

  @ApiProperty({ enum: ['generic', 'category_index', 'author_index'] })
  @IsIn(['generic', 'category_index', 'author_index'])
  type!: 'generic' | 'category_index' | 'author_index';

  @ApiProperty({ description: 'Page content (markdown/HTML/text)' })
  @IsString()
  content!: string;

  // Note: language for admin endpoints is derived from admin context (/:lang or X-Admin-Language)
  // The field remains optional for backward compatibility, but the controller ignores it.
  @ApiProperty({ enum: ['en', 'es', 'fr', 'pt'], required: false })
  @IsOptional()
  @IsIn(['en', 'es', 'fr', 'pt'])
  language?: 'en' | 'es' | 'fr' | 'pt';

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
}

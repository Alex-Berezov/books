import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';

export class UpdatePageDto {
  @ApiPropertyOptional({ description: 'Slug страницы', pattern: SLUG_PATTERN })
  @IsOptional()
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  slug?: string;

  @ApiPropertyOptional({ description: 'Заголовок страницы' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  title?: string;

  @ApiPropertyOptional({ enum: ['generic', 'category_index', 'author_index'] })
  @IsOptional()
  @IsIn(['generic', 'category_index', 'author_index'])
  type?: 'generic' | 'category_index' | 'author_index';

  @ApiPropertyOptional({ description: 'Контент страницы (markdown/HTML/текст)' })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional({ enum: ['en', 'es', 'fr', 'pt'] })
  @IsOptional()
  @IsIn(['en', 'es', 'fr', 'pt'])
  language?: 'en' | 'es' | 'fr' | 'pt';

  @ApiPropertyOptional({ description: 'ID SEO сущности', nullable: true })
  @IsOptional()
  seoId?: number | null;

  @ApiPropertyOptional({ description: 'Статус публикации', enum: ['draft', 'published'] })
  @IsOptional()
  @IsIn(['draft', 'published'])
  status?: 'draft' | 'published';
}

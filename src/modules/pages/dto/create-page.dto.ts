import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';

export class CreatePageDto {
  @ApiProperty({ description: 'Slug страницы', pattern: SLUG_PATTERN })
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  slug!: string;

  @ApiProperty({ description: 'Заголовок страницы' })
  @IsString()
  @MinLength(2)
  title!: string;

  @ApiProperty({ enum: ['generic', 'category_index', 'author_index'] })
  @IsIn(['generic', 'category_index', 'author_index'])
  type!: 'generic' | 'category_index' | 'author_index';

  @ApiProperty({ description: 'Контент страницы (markdown/HTML/текст)' })
  @IsString()
  content!: string;

  // Внимание: язык для админских ручек создаётся из контекста админки (/:lang или X-Admin-Language)
  // Поле оставлено опциональным для обратной совместимости, но контроллер его игнорирует.
  @ApiProperty({ enum: ['en', 'es', 'fr', 'pt'], required: false })
  @IsOptional()
  @IsIn(['en', 'es', 'fr', 'pt'])
  language?: 'en' | 'es' | 'fr' | 'pt';

  @ApiProperty({ description: 'ID SEO сущности', required: false, nullable: true })
  @IsOptional()
  seoId?: number | null;
}

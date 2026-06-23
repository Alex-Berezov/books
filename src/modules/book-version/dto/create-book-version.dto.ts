import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MinLength,
  IsInt,
  Min,
  Max,
  IsArray,
} from 'class-validator';
import { Language as PrismaLanguage, BookType as PrismaBookType } from '@prisma/client';

export class CreateBookVersionDto {
  @ApiProperty({
    enum: Object.values(PrismaLanguage),
    description: 'Язык версии книги',
    example: 'en',
  })
  @IsIn(Object.values(PrismaLanguage))
  language!: PrismaLanguage;

  @ApiPropertyOptional({ description: 'Слаг версии книги', example: 'harry-potter' })
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiProperty({ description: 'Заголовок', example: "Harry Potter and the Philosopher's Stone" })
  @IsString()
  @MinLength(2)
  title!: string;

  @ApiProperty({ description: 'Автор', example: 'J.K. Rowling' })
  @IsString()
  author!: string;

  @ApiProperty({ description: 'Описание', example: 'First book of the series' })
  @IsString()
  description!: string;

  @ApiProperty({ description: 'URL обложки', example: 'https://cdn.example.com/covers/hp1.jpg' })
  @IsUrl()
  coverImageUrl!: string;

  @ApiProperty({
    enum: Object.values(PrismaBookType),
    description: 'Тип контента',
    example: 'text',
  })
  @IsIn(Object.values(PrismaBookType))
  type!: PrismaBookType;

  @ApiProperty({ description: 'Бесплатная ли версия', example: true })
  @IsBoolean()
  isFree!: boolean;

  @ApiPropertyOptional({ description: 'Реферальная ссылка', example: 'https://amazon.com/ref123' })
  @IsOptional()
  @IsUrl()
  referralUrl?: string;

  @ApiPropertyOptional({
    description: 'ID основной категории книги для хлебных крошек',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID()
  primaryCategoryId?: string | null;

  @ApiPropertyOptional({ description: 'Год первой публикации книги', example: 1890 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2100)
  firstPublishedYear?: number | null;

  @ApiPropertyOptional({ description: 'Год публикации данного издания', example: 1891 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2100)
  editionPublishedYear?: number | null;

  @ApiPropertyOptional({
    description: 'Опциональные SEO metaTitle',
    example: 'Harry Potter — Summary',
  })
  @IsOptional()
  @IsString()
  seoMetaTitle?: string;

  @ApiPropertyOptional({
    description: 'Опциональные SEO metaDescription',
    example: 'Overview, themes and details about the book',
  })
  @IsOptional()
  @IsString()
  seoMetaDescription?: string;

  @ApiPropertyOptional({ description: 'Оригинальный язык книги', example: 'en' })
  @IsOptional()
  @IsString()
  originalLanguage?: string | null;

  @ApiPropertyOptional({ description: 'Статус авторских прав', example: 'public_domain' })
  @IsOptional()
  @IsString()
  copyrightStatus?: string | null;

  @ApiPropertyOptional({
    description: 'Оригинальное название книги',
    example: 'The Picture of Dorian Gray',
  })
  @IsOptional()
  @IsString()
  originalTitle?: string | null;

  @ApiPropertyOptional({
    description: 'Альтернативные названия книги',
    example: ['Dorian Gray'],
  })
  @IsOptional()
  @IsArray()
  alternativeTitles?: any;

  @ApiPropertyOptional({
    description: 'Краткое описание книги',
    example: 'A classic story of youth...',
  })
  @IsOptional()
  @IsString()
  shortDescription?: string | null;

  @ApiPropertyOptional({
    description: 'Краткое содержание книги',
    example: 'The story follows Dorian...',
  })
  @IsOptional()
  @IsString()
  summaryShort?: string | null;

  @ApiPropertyOptional({
    description: 'Символы в книге',
    example: [{ title: 'Portrait', description: 'Represents the soul' }],
  })
  @IsOptional()
  @IsArray()
  symbols?: any;

  @ApiPropertyOptional({
    description: 'Альт-текст обложки',
    example: 'Vintage cover art',
  })
  @IsOptional()
  @IsString()
  coverAlt?: string | null;

  @ApiPropertyOptional({
    description: 'Ссылка на страницу автора',
    example: 'https://example.com/author/oscar-wilde',
  })
  @IsOptional()
  @IsString()
  authorPageUrl?: string | null;

  @ApiPropertyOptional({
    description: 'Идентификатор автора (UUID)',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsOptional()
  @IsString()
  authorId?: string | null;

  @ApiPropertyOptional({
    description: 'Персонажи книги',
    example: [{ name: 'Dorian Gray', description: 'Main character' }],
  })
  @IsOptional()
  @IsArray()
  characters?: any;

  @ApiPropertyOptional({
    description: 'Цитаты из книги',
    example: [{ text: 'To live is the rarest thing in the world.', author: 'Oscar Wilde' }],
  })
  @IsOptional()
  @IsArray()
  quotes?: any;

  @ApiPropertyOptional({
    description: 'FAQ по книге',
    example: [{ question: 'What is the genre?', answer: 'Gothic fiction' }],
  })
  @IsOptional()
  @IsArray()
  faq?: any;

  @ApiPropertyOptional({ description: 'Темы книги', example: ['Art', 'Morality'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  themes?: string[];
}

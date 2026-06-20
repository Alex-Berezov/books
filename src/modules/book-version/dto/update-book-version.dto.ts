import { ApiPropertyOptional } from '@nestjs/swagger';
import { CreateBookVersionDto } from './create-book-version.dto';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MinLength,
  ValidateIf,
  IsInt,
  Min,
  Max,
  IsArray,
} from 'class-validator';
import { Language as PrismaLanguage, BookType as PrismaBookType } from '@prisma/client';

export class UpdateBookVersionDto implements Partial<CreateBookVersionDto> {
  @ApiPropertyOptional({ enum: Object.values(PrismaLanguage), example: 'es' })
  @IsOptional()
  @IsIn(Object.values(PrismaLanguage))
  language?: PrismaLanguage;

  @ApiPropertyOptional({ description: 'Слаг версии книги', example: 'harry-potter' })
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiPropertyOptional({ example: "Harry Potter and the Sorcerer's Stone" })
  @IsOptional()
  @IsString()
  @MinLength(2)
  title?: string;

  @ApiPropertyOptional({ example: 'J.K. Rowling' })
  @IsOptional()
  @IsString()
  author?: string;

  @ApiPropertyOptional({ example: 'Updated description text' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/covers/hp1-new.jpg' })
  @IsOptional()
  @IsUrl()
  coverImageUrl?: string;

  @ApiPropertyOptional({ enum: Object.values(PrismaBookType), example: 'audio' })
  @IsOptional()
  @IsIn(Object.values(PrismaBookType))
  type?: PrismaBookType;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isFree?: boolean;

  @ApiPropertyOptional({ example: 'https://partner.example.com/ref/456' })
  @IsOptional()
  @IsUrl()
  referralUrl?: string;

  @ApiPropertyOptional({ example: 'HP1 — Summary (Updated)' })
  @IsOptional()
  @IsString()
  seoMetaTitle?: string;

  @ApiPropertyOptional({ example: 'New meta description text' })
  @IsOptional()
  @IsString()
  seoMetaDescription?: string;

  @ApiPropertyOptional({
    description: 'Media asset id for audio preview (short audio sample). Pass null to clear.',
    example: '550e8400-e29b-41d4-a716-446655440000',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  previewMediaId?: string | null;

  @ApiPropertyOptional({
    description: 'ID основной категории книги для хлебных крошек. Pass null to clear.',
    example: '550e8400-e29b-41d4-a716-446655440000',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  primaryCategoryId?: string | null;

  @ApiPropertyOptional({
    description: 'Год первой публикации книги. Pass null to clear.',
    example: 1890,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(2100)
  firstPublishedYear?: number | null;

  @ApiPropertyOptional({
    description: 'Год публикации данного издания. Pass null to clear.',
    example: 1891,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(2100)
  editionPublishedYear?: number | null;

  @ApiPropertyOptional({ description: 'Оригинальный язык книги', example: 'en', nullable: true })
  @IsOptional()
  @IsString()
  originalLanguage?: string | null;

  @ApiPropertyOptional({
    description: 'Статус авторских прав',
    example: 'public_domain',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  copyrightStatus?: string | null;

  @ApiPropertyOptional({
    description: 'Оригинальное название книги',
    example: 'The Picture of Dorian Gray',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  originalTitle?: string | null;

  @ApiPropertyOptional({
    description: 'Альтернативные названия книги',
    example: ['Dorian Gray'],
    nullable: true,
  })
  @IsOptional()
  @IsArray()
  alternativeTitles?: any;

  @ApiPropertyOptional({
    description: 'Краткое описание книги',
    example: 'A classic story of youth...',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  shortDescription?: string | null;

  @ApiPropertyOptional({
    description: 'Краткое содержание книги',
    example: 'The story follows Dorian...',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  summaryShort?: string | null;

  @ApiPropertyOptional({
    description: 'Символы в книге',
    example: [{ title: 'Portrait', description: 'Represents the soul' }],
    nullable: true,
  })
  @IsOptional()
  @IsArray()
  symbols?: any;

  @ApiPropertyOptional({
    description: 'Альт-текст обложки',
    example: 'Vintage cover art',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  coverAlt?: string | null;

  @ApiPropertyOptional({
    description: 'Ссылка на страницу автора',
    example: 'https://example.com/author/oscar-wilde',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  authorPageUrl?: string | null;

  @ApiPropertyOptional({
    description: 'Персонажи книги',
    example: [{ name: 'Dorian Gray', description: 'Main character' }],
    nullable: true,
  })
  @IsOptional()
  @IsArray()
  characters?: any;

  @ApiPropertyOptional({
    description: 'Цитаты из книги',
    example: [{ text: 'To live is the rarest thing in the world.', author: 'Oscar Wilde' }],
    nullable: true,
  })
  @IsOptional()
  @IsArray()
  quotes?: any;

  @ApiPropertyOptional({
    description: 'FAQ по книге',
    example: [{ question: 'What is the genre?', answer: 'Gothic fiction' }],
    nullable: true,
  })
  @IsOptional()
  @IsArray()
  faq?: any;

  @ApiPropertyOptional({ description: 'Темы книги', example: ['Art', 'Morality'], nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  themes?: string[];
}

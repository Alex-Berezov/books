import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUrl,
  IsBoolean,
  IsEnum,
  IsInt,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import { BookType } from '@prisma/client';

export class CreateBookFromClearanceVersionDto {
  @ApiProperty({ enum: Language, description: 'Language of the book version' })
  @IsEnum(Language)
  language!: Language;

  @ApiProperty({ description: 'Title of the book' })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(500)
  title!: string;

  @ApiProperty({ description: 'Author of the book' })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(500)
  author!: string;

  /**
   * WP-L.1: описание и обложка — контентная работа, а не часть клиренса. Требовать их здесь
   * означало заставлять редактора сочинять текст в форме прав, чтобы потом переписать его в
   * разделе «Книги». Канал остаётся способен их принять — будущий агент переноса из Gutenberg
   * пришлёт их сразу, — но обязательными они больше не являются.
   *
   * Компенсация: пустое описание или обложка закрывают публикацию блокером гейта
   * `VERSION_CONTENT_INCOMPLETE`. Версия заводится черновиком, наружу пустая оболочка не уйдёт.
   */
  @ApiPropertyOptional({ description: 'Description of the book' })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({ description: 'Cover image URL' })
  @IsOptional()
  @IsUrl()
  coverImageUrl?: string | null;

  @ApiProperty({ enum: BookType, description: 'Type of the book' })
  @IsEnum(BookType)
  type!: BookType;

  @ApiProperty({ description: 'Whether the book is free' })
  @IsBoolean()
  isFree!: boolean;

  @ApiPropertyOptional({ description: 'Referral URL (for referral type)' })
  @IsOptional()
  @IsUrl()
  referralUrl?: string | null;

  @ApiPropertyOptional({ description: 'Primary category ID' })
  @IsOptional()
  @IsString()
  primaryCategoryId?: string | null;

  @ApiPropertyOptional({ description: 'First published year' })
  @IsOptional()
  @IsInt()
  firstPublishedYear?: number | null;

  @ApiPropertyOptional({ description: 'Edition published year' })
  @IsOptional()
  @IsInt()
  editionPublishedYear?: number | null;

  @ApiPropertyOptional({ description: 'Original language' })
  @IsOptional()
  @IsString()
  originalLanguage?: string | null;

  @ApiPropertyOptional({ description: 'Original title' })
  @IsOptional()
  @IsString()
  originalTitle?: string | null;

  @ApiPropertyOptional({ description: 'Copyright status' })
  @IsOptional()
  @IsString()
  copyrightStatus?: string | null;

  @ApiPropertyOptional({ description: 'Author page URL' })
  @IsOptional()
  @IsUrl()
  authorPageUrl?: string | null;

  @ApiPropertyOptional({ description: 'Author ID' })
  @IsOptional()
  @IsString()
  authorId?: string | null;

  @ApiPropertyOptional({ description: 'Short description' })
  @IsOptional()
  @IsString()
  shortDescription?: string | null;

  @ApiPropertyOptional({ description: 'Short summary' })
  @IsOptional()
  @IsString()
  summaryShort?: string | null;

  @ApiPropertyOptional({ description: 'Cover alt text' })
  @IsOptional()
  @IsString()
  coverAlt?: string | null;
}

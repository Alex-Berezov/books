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
} from 'class-validator';
import { Language as PrismaLanguage, BookType as PrismaBookType } from '@prisma/client';

export class UpdateBookVersionDto implements Partial<CreateBookVersionDto> {
  @ApiPropertyOptional({ enum: Object.values(PrismaLanguage), example: 'es' })
  @IsOptional()
  @IsIn(Object.values(PrismaLanguage))
  language?: PrismaLanguage;

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
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { CreateBookVersionDto } from './create-book-version.dto';
import { IsBoolean, IsIn, IsOptional, IsString, IsUrl, MinLength } from 'class-validator';
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
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { CreateBookVersionDto } from './create-book-version.dto';
import { IsBoolean, IsIn, IsOptional, IsString, IsUrl, MinLength } from 'class-validator';
import { Language as PrismaLanguage, BookType as PrismaBookType } from '@prisma/client';

export class UpdateBookVersionDto implements Partial<CreateBookVersionDto> {
  @ApiPropertyOptional({ enum: Object.values(PrismaLanguage) })
  @IsOptional()
  @IsIn(Object.values(PrismaLanguage))
  language?: PrismaLanguage;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  author?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  coverImageUrl?: string;

  @ApiPropertyOptional({ enum: Object.values(PrismaBookType) })
  @IsOptional()
  @IsIn(Object.values(PrismaBookType))
  type?: PrismaBookType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isFree?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  referralUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  seoMetaTitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  seoMetaDescription?: string;
}

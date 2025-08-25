import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, IsUrl, MinLength } from 'class-validator';
import { Language as PrismaLanguage, BookType as PrismaBookType } from '@prisma/client';

export class CreateBookVersionDto {
  @ApiProperty({
    enum: Object.values(PrismaLanguage),
    description: 'Язык версии книги',
    example: 'en',
  })
  @IsIn(Object.values(PrismaLanguage))
  language!: PrismaLanguage;

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
}

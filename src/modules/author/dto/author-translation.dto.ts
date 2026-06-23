import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import { IsEnum, IsString, MinLength, IsOptional, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class AuthorQuoteDto {
  @ApiProperty({ description: 'Text of the quote' })
  @IsString()
  text!: string;

  @ApiPropertyOptional({ description: 'Source of the quote' })
  @IsOptional()
  @IsString()
  source?: string;
}

export class AuthorFaqDto {
  @ApiProperty({ description: 'Question text' })
  @IsString()
  question!: string;

  @ApiProperty({ description: 'Answer text' })
  @IsString()
  answer!: string;
}

export class AuthorTranslationDto {
  @ApiProperty({ enum: Language })
  @IsEnum(Language)
  language!: Language;

  @ApiProperty({ description: 'Name of the author in this language' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiPropertyOptional({ description: 'Biography of the author in this language' })
  @IsOptional()
  @IsString()
  biography?: string;

  @ApiPropertyOptional({ description: 'Quotes array', type: [AuthorQuoteDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AuthorQuoteDto)
  quotes?: AuthorQuoteDto[];

  @ApiPropertyOptional({ description: 'FAQ array', type: [AuthorFaqDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AuthorFaqDto)
  faq?: AuthorFaqDto[];

  @ApiPropertyOptional({ description: 'Slugs of similar authors', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  similarSlugs?: string[];
}

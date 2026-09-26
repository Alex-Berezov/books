import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import {
  IsEnum,
  IsString,
  MinLength,
  IsOptional,
  IsArray,
  ValidateNested,
  Matches,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UpdateSeoDto } from '../../seo/dto/update-seo.dto';
import { SLUG_PATTERN, SLUG_REGEX_README } from '../../../shared/validators/slug';
import { RICH_HTML_MAX_LENGTH, RichHtml } from '../../../shared/validators/rich-html.decorator';
import {
  FAQ_ANSWER_MAX_LENGTH,
  FAQ_QUESTION_MAX_LENGTH,
} from '../../../shared/constants/validation';

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
  @ApiProperty({ description: 'Question text', maxLength: FAQ_QUESTION_MAX_LENGTH })
  @IsString()
  @MaxLength(FAQ_QUESTION_MAX_LENGTH)
  question!: string;

  @ApiProperty({ description: 'Answer text', maxLength: FAQ_ANSWER_MAX_LENGTH })
  @IsString()
  @MaxLength(FAQ_ANSWER_MAX_LENGTH)
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

  @ApiProperty({
    description: 'Author unique slug for this language',
    example: 'oscar-wilde',
    pattern: SLUG_PATTERN,
  })
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  slug!: string;

  @ApiPropertyOptional({ description: 'Biography of the author in this language' })
  @IsOptional()
  @IsString()
  @RichHtml(RICH_HTML_MAX_LENGTH.text)
  biography?: string;

  @ApiPropertyOptional({
    description: 'Wikidata URL for this language',
    example: 'https://www.wikidata.org/wiki/Q30875',
  })
  @IsOptional()
  @IsString()
  wikidataUrl?: string;

  @ApiPropertyOptional({
    description: 'Wikipedia URL for this language',
    example: 'https://en.wikipedia.org/wiki/Oscar_Wilde',
  })
  @IsOptional()
  @IsString()
  wikipediaUrl?: string;

  @ApiPropertyOptional({
    description: 'Author photo URL for this language',
    example: 'https://example.com/author.jpg',
  })
  @IsOptional()
  @IsString()
  photoUrl?: string;

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

  @ApiPropertyOptional({ description: 'SEO metadata for this language', type: UpdateSeoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateSeoDto)
  seo?: UpdateSeoDto;
}

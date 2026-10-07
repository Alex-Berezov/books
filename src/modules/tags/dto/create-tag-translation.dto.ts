import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  SLUG_PATTERN,
  SLUG_REGEX_README,
  SLUG_MAX_LENGTH,
  SLUG_MAX_LENGTH_MESSAGE,
} from '../../../shared/validators/slug';
import { IsAbsoluteHttpUrl } from '../../../shared/validators/absolute-http-url.decorator';
import { SeoInputDto } from '../../pages/dto/seo-input.dto';
import { RICH_HTML_MAX_LENGTH, RichHtml } from '../../../shared/validators/rich-html.decorator';
import {
  FAQ_ANSWER_MAX_LENGTH,
  FAQ_QUESTION_MAX_LENGTH,
} from '../../../shared/constants/validation';

export class TagFaqDto {
  @ApiProperty({ description: 'Question text', maxLength: FAQ_QUESTION_MAX_LENGTH })
  @IsString()
  @MaxLength(FAQ_QUESTION_MAX_LENGTH)
  question!: string;

  @ApiProperty({ description: 'Answer text', maxLength: FAQ_ANSWER_MAX_LENGTH })
  @IsString()
  @MaxLength(FAQ_ANSWER_MAX_LENGTH)
  answer!: string;
}

export class CreateTagTranslationDto {
  @ApiProperty({ enum: Object.values(Language) })
  @IsEnum(Language)
  language!: Language;

  @ApiProperty({ description: 'Localized tag name' })
  @IsString()
  @MinLength(2)
  name!: string;

  @ApiProperty({
    description: 'Localized tag slug',
    pattern: SLUG_PATTERN,
    maxLength: SLUG_MAX_LENGTH,
  })
  @IsString()
  @Matches(new RegExp(SLUG_PATTERN), { message: SLUG_REGEX_README })
  @MaxLength(SLUG_MAX_LENGTH, { message: SLUG_MAX_LENGTH_MESSAGE })
  slug!: string;

  @ApiPropertyOptional({ description: 'HTML description for the tag page' })
  @IsOptional()
  @IsString()
  @RichHtml(RICH_HTML_MAX_LENGTH.text)
  description?: string | null;

  @ApiPropertyOptional({ description: 'H1 heading for the tag page', type: String, nullable: true })
  @IsOptional()
  @IsString()
  h1?: string | null;

  @ApiPropertyOptional({ description: 'Short description for cards/lists' })
  @IsOptional()
  @IsString()
  shortDescription?: string | null;

  @ApiPropertyOptional({ description: 'Meta title for SEO', type: String, nullable: true })
  @IsOptional()
  @IsString()
  metaTitle?: string | null;

  @ApiPropertyOptional({ description: 'Meta description for SEO' })
  @IsOptional()
  @IsString()
  metaDescription?: string | null;

  @ApiPropertyOptional({ description: 'Open Graph title', type: String, nullable: true })
  @IsOptional()
  @IsString()
  ogTitle?: string | null;

  @ApiPropertyOptional({ description: 'Open Graph description' })
  @IsOptional()
  @IsString()
  ogDescription?: string | null;

  @ApiPropertyOptional({ description: 'Open Graph image URL' })
  @IsOptional()
  @IsAbsoluteHttpUrl()
  ogImageUrl?: string | null;

  @ApiPropertyOptional({ description: 'Open Graph image alt text', type: String, nullable: true })
  @IsOptional()
  @IsString()
  ogImageAlt?: string | null;

  @ApiPropertyOptional({ description: 'Canonical URL' })
  @IsOptional()
  @IsAbsoluteHttpUrl()
  canonicalUrl?: string;

  @ApiPropertyOptional({ description: 'Robots directive', example: 'index, follow' })
  @IsOptional()
  @IsString()
  robots?: string;

  // `TagTranslation.indexable` — `NOT NULL` (`prisma/schema.prisma:798`), поэтому `null`
  // отбивается валидатором, а не Prisma (`LEGACY-363`, `STYLE_GUIDE.md` §7): с 30.09.2026
  // (`LEGACY-422`, `T73`) `createTranslation` пишет поле в `data`, и `@IsOptional()`
  // пропустил бы `null` до пятисотого.
  @ApiPropertyOptional({ description: 'Whether this tag should be indexed', default: true })
  @ValidateIf((_o, value) => value !== undefined)
  @IsBoolean()
  indexable?: boolean;

  @ApiPropertyOptional({
    description: 'FAQ items',
    type: [TagFaqDto],
    nullable: true,
    example: [{ question: 'What is this?', answer: 'This is...' }],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TagFaqDto)
  faq?: TagFaqDto[] | null;

  @ApiPropertyOptional({
    description: 'Related tag slugs',
    type: [String],
    example: ['aestheticism', 'beauty'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(new RegExp(SLUG_PATTERN), { each: true, message: SLUG_REGEX_README })
  relatedTagSlugs?: string[];

  @ApiPropertyOptional({
    description: 'Related genre/category slugs',
    type: [String],
    example: ['classic-literature', 'philosophical-fiction'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(new RegExp(SLUG_PATTERN), { each: true, message: SLUG_REGEX_README })
  relatedGenreSlugs?: string[];

  @ApiPropertyOptional({
    description: 'Related category slugs',
    type: [String],
    example: ['classic-literature', 'victorian-literature'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(new RegExp(SLUG_PATTERN), { each: true, message: SLUG_REGEX_README })
  relatedCategorySlugs?: string[];

  @ApiPropertyOptional({
    description: 'Related collection slugs',
    type: [String],
    example: ['short-reads', 'feel-good-books'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(new RegExp(SLUG_PATTERN), { each: true, message: SLUG_REGEX_README })
  relatedCollectionSlugs?: string[];

  @ApiPropertyOptional({ description: 'SEO metadata', type: SeoInputDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SeoInputDto)
  seo?: SeoInputDto;
}

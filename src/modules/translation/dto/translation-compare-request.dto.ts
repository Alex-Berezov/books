import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { MONEY_DOC, MONEY_PATTERN, notUndefined, toMoneyString } from '../../llm/dto/llm-money';

export const COMPARE_MIN_MODELS = 2;
export const COMPARE_MAX_MODELS = 4;

/** Одна модель - строкой, несколько - повтором параметра или через запятую. */
const toModelList = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.split(',').filter((m) => m !== '') : value;

/** Глава, язык и 2-4 модели сравнения (`F05-3`, шаг 3); общая часть оценки и запуска. */
export class TranslationCompareEstimateQueryDto {
  @ApiProperty({ type: Number, minimum: 1, description: 'Reader chapter number' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chapterNumber!: number;

  @ApiProperty({ enum: Language, enumName: 'Language' })
  @IsEnum(Language)
  targetLanguage!: Language;

  @ApiProperty({
    type: [String],
    minItems: COMPARE_MIN_MODELS,
    maxItems: COMPARE_MAX_MODELS,
    description: 'OpenRouter model ids, each once; in a query - repeated or comma-separated',
  })
  @Transform(toModelList)
  @IsArray()
  @ArrayMinSize(COMPARE_MIN_MODELS)
  @ArrayMaxSize(COMPARE_MAX_MODELS)
  @ArrayUnique({ message: 'models must not repeat' })
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  models!: string[];
}

export class StartTranslationCompareDto extends TranslationCompareEstimateQueryDto {
  @ApiPropertyOptional({
    ...MONEY_DOC,
    description:
      'Limit of the compare operation; it covers the translations and must also fit a dossier and a glossary that are built first. Default - the suggested limit of the estimate',
  })
  @ValidateIf(notUndefined)
  @Transform(toMoneyString)
  @Matches(MONEY_PATTERN, {
    message: 'limitUsd must be a non-negative amount with up to 8 decimals',
  })
  limitUsd?: string;
}

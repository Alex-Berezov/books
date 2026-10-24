import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaginationDto } from '../../../shared/dto/pagination.dto';
import { MONEY_DOC, MONEY_PATTERN, notUndefined, toMoneyString } from '../../llm/dto/llm-money';
import { ResumeLlmOperationDto } from '../../llm-worker/dto/resume-llm-operation.dto';
import { toQueryList } from './translation-compare-request.dto';

/** Языки и модель перевода запуска (`F05-4b`, шаги 2-3); общая часть оценки и старта. */
export class TranslationRunEstimateQueryDto {
  @ApiProperty({
    enum: Language,
    enumName: 'Language',
    isArray: true,
    description: 'Target languages, each once; in a query - repeated or comma-separated',
  })
  @Transform(toQueryList)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(Object.values(Language).length)
  @ArrayUnique({ message: 'languages must not repeat' })
  @IsEnum(Language, { each: true })
  languages!: Language[];

  @ApiPropertyOptional({
    type: String,
    example: 'anthropic/claude-sonnet-5.5',
    description:
      'Translate model of this run only, one model without fallbacks; settings are not changed. Default - the translate stage model',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  translateModel?: string;
}

export class StartTranslationRunDto extends TranslationRunEstimateQueryDto {
  @ApiPropertyOptional({
    ...MONEY_DOC,
    description:
      'Limit of the run operation; must fit the dossier and glossaries built first. Default - LlmBudget.defaultRunLimitUsd',
  })
  @ValidateIf(notUndefined)
  @Transform(toMoneyString)
  @Matches(MONEY_PATTERN, {
    message: 'limitUsd must be a non-negative amount with up to 8 decimals',
  })
  limitUsd?: string;
}

/**
 * Модели этапов запуска поверх снимка: одна модель без запасных (решение арбитра
 * `F05 | F05-4a`, В1). Этапы - `translate`, `check_semantic` (выход из паузы
 * `NO_COMPLIANT_PROVIDER` на сверке смысла, решение арбитра `F05 | F05-5`), `metadata` (поля
 * версии, `F05-6`) и `final_check` (итоговая проверка, `F05-6`, 6c): у `split` последний
 * запасной - код (Р7), Jev не обязателен. Чужой этап - 400 глобальной валидацией
 * (`forbidNonWhitelisted`).
 */
export class TranslationRunStageModelsDto {
  @ApiPropertyOptional({ type: String, example: 'anthropic/claude-sonnet-5.5' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  translate?: string;

  @ApiPropertyOptional({
    type: String,
    example: 'deepseek/deepseek-v4-pro',
    description: 'Meaning check model: of another family than the translate model of the run',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  check_semantic?: string;

  @ApiPropertyOptional({
    type: String,
    example: 'anthropic/claude-sonnet-5.5',
    description: 'Model of the version fields (title, description, author, chapter titles)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  metadata?: string;

  @ApiPropertyOptional({
    type: String,
    example: 'deepseek/deepseek-v4-pro',
    description: 'Final check model: of another family than the translate model of the run',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  final_check?: string;
}

/** «Продолжить» запуск: новый лимит и модели этапов (`F05-4`, шаг 6). */
export class ResumeTranslationRunDto extends ResumeLlmOperationDto {
  @ApiPropertyOptional({
    type: () => TranslationRunStageModelsDto,
    description:
      'Stage models of this run over its snapshot, one model without fallbacks: the way out of NO_COMPLIANT_PROVIDER',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => TranslationRunStageModelsDto)
  stageModels?: TranslationRunStageModelsDto;
}

/**
 * Список запусков книги (`F05-7`, решение арбитра `F05 | F05-7`, /fix В1): блок версии берёт
 * идущие запуски своей версии и её последний, а не первую страницу всей книги.
 */
export class ListTranslationRunsQueryDto extends PaginationDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Only runs of this source version' })
  @IsOptional()
  @IsUUID()
  bookVersionId?: string;

  @ApiPropertyOptional({ description: 'Only runs not finished: the operation active or paused' })
  @IsOptional()
  // Не «да» и не «нет» - значение как есть, `@IsBoolean` отвечает 400, а не снимает фильтр молча.
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  active?: boolean;
}

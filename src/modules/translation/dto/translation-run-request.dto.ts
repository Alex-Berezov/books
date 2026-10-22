import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { ResumeLlmOperationDto } from '../../llm-worker/dto/resume-llm-operation.dto';

/**
 * Модели этапов запуска поверх снимка: одна модель без запасных (решение арбитра
 * `F05 | F05-4a`, В1). Этап - только `translate`: у `split` последний запасной - код (Р7).
 * Чужой этап - 400 глобальной валидацией (`forbidNonWhitelisted`).
 */
export class TranslationRunStageModelsDto {
  @ApiPropertyOptional({ type: String, example: 'anthropic/claude-sonnet-5.5' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  translate?: string;
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

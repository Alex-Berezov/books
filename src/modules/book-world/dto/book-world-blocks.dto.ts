import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';
import { applyDecorators } from '@nestjs/common';
import { Trim } from '../../../shared/validators/trim.decorator';
import { BOOK_ANALYSIS_LIMITS } from '../../book-analysis/dto/book-analysis-blocks.dto';
import {
  BLOCK_KEY_REGEX,
  Key,
  NestedList,
  OptionalText,
  RequiredText,
  isAbsent,
} from '../../../shared/validators/block-fields.decorator';

/**
 * Блоки сущности мира книги (F08-1), пока только героя (`character`). Форма —
 * `books-app-docs/features/F08-book-wiki/tech.md` §3, та же форма — JSON импорта и промпт
 * `prompts/world-character.md`. Пределы (D5) — те же числа, что у анализа (`BOOK_ANALYSIS_LIMITS`):
 * страница сущности не длиннее страницы анализа. Зеркало на фронте — `books-front/lib/admin/book-world-blocks.ts`.
 *
 * Строки обрезаются по краям; пустая строка у необязательного поля — «нет значения», у обязательного —
 * отказ. Ссылки ключей, главы версии и дословность цитат проверяются не здесь, а на слитой записи
 * (`world-refs.ts`, `book-world.service.ts`).
 */
export const BOOK_WORLD_LIMITS = {
  // Сущностей в версии: и тело импорта, и итог после слияния (выборки списка и `worldKeys` — этим пределом).
  entities: 100,
  aliases: 30,
  name: BOOK_ANALYSIS_LIMITS.title,
  short: BOOK_ANALYSIS_LIMITS.mainIdea,
  profileField: BOOK_ANALYSIS_LIMITS.title,
  appearance: BOOK_ANALYSIS_LIMITS.mediumText,
  character: BOOK_ANALYSIS_LIMITS.interpretation,
  arcText: BOOK_ANALYSIS_LIMITS.mediumText,
  stages: 8,
  scenes: 12,
  relations: 10,
  label: BOOK_ANALYSIS_LIMITS.label,
  quotes: BOOK_ANALYSIS_LIMITS.keyQuotes,
  quote: BOOK_ANALYSIS_LIMITS.quote,
  interpretation: BOOK_ANALYSIS_LIMITS.interpretation,
  critique: BOOK_ANALYSIS_LIMITS.interpretation,
  prototypes: BOOK_ANALYSIS_LIMITS.mediumText,
  adaptations: BOOK_ANALYSIS_LIMITS.adaptations,
  faq: 8,
  sources: BOOK_ANALYSIS_LIMITS.sources,
  title: BOOK_ANALYSIS_LIMITS.title,
  mediumText: BOOK_ANALYSIS_LIMITS.mediumText,
  chapter: BOOK_ANALYSIS_LIMITS.chapter,
  paragraph: 10_000,
  adaptationYear: BOOK_ANALYSIS_LIMITS.adaptationYear,
} as const;

/** Ключ сущности — тот же, что у героя анализа: часть адреса `/wiki/{key}`. */
export const BOOK_WORLD_KEY_REGEX = BLOCK_KEY_REGEX;

/** Типы, которые импорт принимает сейчас; остальные `WorldEntityType` — пачками своего типа (`batches.md` F08-1 п.2). */
export const BOOK_WORLD_IMPORT_TYPES = ['character'] as const;
export type BookWorldImportType = (typeof BOOK_WORLD_IMPORT_TYPES)[number];

/** Номер главы версии — обязателен: цитата сверяется по своей главе, сцена и этап ведут в читалку. */
const RequiredChapter = () => applyDecorators(IsInt(), Min(1), Max(BOOK_WORLD_LIMITS.chapter));

export class BookWorldProfileDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: BOOK_WORLD_LIMITS.profileField })
  @OptionalText(BOOK_WORLD_LIMITS.profileField)
  position?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: BOOK_WORLD_LIMITS.profileField })
  @OptionalText(BOOK_WORLD_LIMITS.profileField)
  relationToMain?: string | null;
}

export class BookWorldArcStageDto {
  @ApiProperty({ maxLength: BOOK_WORLD_LIMITS.title })
  @RequiredText(BOOK_WORLD_LIMITS.title)
  title!: string;

  @ApiProperty({ maxLength: BOOK_WORLD_LIMITS.mediumText })
  @RequiredText(BOOK_WORLD_LIMITS.mediumText)
  text!: string;

  @ApiProperty({ type: Number, minimum: 1 })
  @RequiredChapter()
  chapter!: number;
}

/** Путь героя «в начале → в конце»; этапы вложены (решение арбитра `F08 | F08-1` R7). */
export class BookWorldArcDto {
  @ApiProperty({ maxLength: BOOK_WORLD_LIMITS.arcText })
  @RequiredText(BOOK_WORLD_LIMITS.arcText)
  from!: string;

  @ApiProperty({ maxLength: BOOK_WORLD_LIMITS.arcText })
  @RequiredText(BOOK_WORLD_LIMITS.arcText)
  to!: string;

  @ApiPropertyOptional({ type: [BookWorldArcStageDto], nullable: true })
  @NestedList(() => BookWorldArcStageDto, BOOK_WORLD_LIMITS.stages)
  stages?: BookWorldArcStageDto[] | null;
}

export class BookWorldSceneDto {
  @ApiProperty({ type: Number, minimum: 1 })
  @RequiredChapter()
  chapter!: number;

  @ApiProperty({ maxLength: BOOK_WORLD_LIMITS.title })
  @RequiredText(BOOK_WORLD_LIMITS.title)
  title!: string;

  @ApiProperty({ maxLength: BOOK_WORLD_LIMITS.mediumText })
  @RequiredText(BOOK_WORLD_LIMITS.mediumText)
  text!: string;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    description: 'Paragraph index in the chapter (F08-10); optional',
  })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(BOOK_WORLD_LIMITS.paragraph)
  paragraph?: number | null;
}

export class BookWorldRelationDto {
  @ApiProperty({
    pattern: BOOK_WORLD_KEY_REGEX.source,
    description: 'Key of a world entity or an analysis character of this version',
  })
  @Key()
  to!: string;

  @ApiProperty({ maxLength: BOOK_WORLD_LIMITS.label })
  @RequiredText(BOOK_WORLD_LIMITS.label)
  label!: string;
}

/** Цитата героя или о герое: дословно из указанной главы версии (решение арбитра `F08 | F08-1` R8). */
export class BookWorldQuoteDto {
  @ApiProperty({ maxLength: BOOK_WORLD_LIMITS.quote })
  @RequiredText(BOOK_WORLD_LIMITS.quote)
  text!: string;

  @ApiProperty({ type: Number, minimum: 1 })
  @RequiredChapter()
  chapter!: number;

  @ApiPropertyOptional({ type: String, nullable: true, pattern: BOOK_WORLD_KEY_REGEX.source })
  @Trim()
  @ValidateIf((_o, value) => !isAbsent(value))
  @Key()
  speakerKey?: string | null;

  @ApiProperty({ maxLength: BOOK_WORLD_LIMITS.interpretation })
  @RequiredText(BOOK_WORLD_LIMITS.interpretation)
  interpretation!: string;
}

export class BookWorldAdaptationDto {
  @ApiProperty({ maxLength: BOOK_WORLD_LIMITS.title })
  @RequiredText(BOOK_WORLD_LIMITS.title)
  title!: string;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(BOOK_WORLD_LIMITS.adaptationYear.min)
  @Max(BOOK_WORLD_LIMITS.adaptationYear.max)
  year?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: BOOK_WORLD_LIMITS.title })
  @OptionalText(BOOK_WORLD_LIMITS.title)
  actor?: string | null;

  @ApiProperty({ maxLength: BOOK_WORLD_LIMITS.mediumText })
  @RequiredText(BOOK_WORLD_LIMITS.mediumText)
  differences!: string;
}

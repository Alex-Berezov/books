import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import { FAQ_ANSWER_MAX_LENGTH, FAQ_QUESTION_MAX_LENGTH } from '../constants/validation';

/**
 * Пара «вопрос - ответ» Json-колонки `faq`.
 *
 * 🔴 Живёт в `shared`, а не в модуле страниц: одну и ту же форму описывают ответы страниц,
 * книги, версии, категории и тега - шесть модулей. До 10.09.2026 класс лежал в
 * `pages/dto/page-response.dto.ts` под именем `PageFaqItemDto`, и пять модулей тянули
 * импорт из чужого домена.
 *
 * 🔴 Отдельным классом, а не встроенной схемой `items: { type: 'object', properties: ... }`:
 * у встроенной не было `required`, поэтому `question` и `answer` выходили в схему
 * необязательными, и рукописный `FaqItem` фронта (оба поля обязательны) переставал
 * сходиться со схемой машинно (`LEGACY-374`).
 *
 * `question`/`answer` несут `@IsString()` ради входа — с 25.09.2026 (`LEGACY-402`) на этот класс
 * под `@ValidateNested({ each: true })` + `@Type()` заведены `CreatePageDto`/`UpdatePageDto`
 * (`LEGACY-381`), `CreateBookVersionDto`/`UpdateBookVersionDto.faq`,
 * `CreateCategoryTranslationDto`/`UpdateCategoryTranslationDto.faq` и `faq` в DTO импорта тега
 * и категории. Декораторы не мешают модулям, где класс стоит только в ответе и `validate()`
 * по нему не зовётся (`TagTranslation`/`CategoryTranslation` в выдаче) - там свой путь чтения,
 * не через `validateSync`.
 */
export class FaqItemDto {
  @ApiProperty({ type: String, example: 'What is this?', maxLength: FAQ_QUESTION_MAX_LENGTH })
  @IsString()
  @MaxLength(FAQ_QUESTION_MAX_LENGTH)
  question!: string;

  @ApiProperty({ type: String, example: 'This is...', maxLength: FAQ_ANSWER_MAX_LENGTH })
  @IsString()
  @MaxLength(FAQ_ANSWER_MAX_LENGTH)
  answer!: string;
}

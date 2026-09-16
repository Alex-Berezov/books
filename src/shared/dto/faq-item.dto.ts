import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

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
 * `question`/`answer` несут `@IsString()` ради страниц (`CreatePageDto`/`UpdatePageDto` берут
 * класс под `@ValidateNested({ each: true })` + `@Type()`, `LEGACY-381`) — декораторы не мешают
 * модулям, где класс стоит только в ответе и `validate()` по нему не зовётся (книга, категория,
 * тег - у них свой вход со своими декораторами, не через этот класс). `CreateBookVersionDto`/
 * `UpdateBookVersionDto.faq` держит форму на входе этим же классом, но без `@ValidateNested()` -
 * та же мягкость, что закрыта здесь только для страниц (`LEGACY-402`).
 */
export class FaqItemDto {
  @ApiProperty({ type: String, example: 'What is this?' })
  @IsString()
  question!: string;

  @ApiProperty({ type: String, example: 'This is...' })
  @IsString()
  answer!: string;
}

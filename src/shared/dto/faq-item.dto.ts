import { ApiProperty } from '@nestjs/swagger';

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
 * ⚠️ Форму на входе не держит ничто: у `CreatePageDto.faq` и `UpdatePageDto.faq` стоит
 * один `@IsOptional()` без `@ValidateNested()`, поэтому в колонку доезжает произвольный
 * JSON. Схема здесь описывает намерение, а не проверенный инвариант.
 */
export class FaqItemDto {
  @ApiProperty({ type: String, example: 'What is this?' })
  question!: string;

  @ApiProperty({ type: String, example: 'This is...' })
  answer!: string;
}

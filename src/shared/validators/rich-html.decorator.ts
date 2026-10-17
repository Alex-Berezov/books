import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { MaxLength, ValidationOptions, registerDecorator } from 'class-validator';
import { sanitizeRichHtml } from '../sanitize/rich-html';
import { richHtmlText } from '../sanitize/rich-html-text';

// Пределы в символах; тело запроса ограничено 1 МБ (app-security.config.ts), глава на кириллице упирается в него раньше.
export const RICH_HTML_MAX_LENGTH = {
  body: 500_000,
  text: 100_000,
} as const;

// Поле с HTML из визуального редактора админки: белый список sanitize-html при записи и предел длины (LEGACY-414).
export const RichHtml = (maxLength: number) =>
  applyDecorators(
    Transform(
      ({ value }: { value: unknown }) =>
        typeof value === 'string' ? sanitizeRichHtml(value) : value,
      { toClassOnly: true },
    ),
    MaxLength(maxLength),
  );

/**
 * HTML из редактора обязан нести видимый текст: пустой редактор отдаёт `<p></p>`, и такой
 * «пересказ» прошёл бы `@IsString()`, а публичная страница вышла бы пустой и в индексе.
 */
export function RichHtmlHasText(validationOptions?: ValidationOptions): PropertyDecorator {
  return (object, propertyName) =>
    registerDecorator({
      name: 'richHtmlHasText',
      target: object.constructor,
      propertyName: propertyName as string,
      options: { message: `${String(propertyName)} must contain text`, ...validationOptions },
      validator: {
        validate: (value: unknown) => typeof value === 'string' && richHtmlText(value) !== '',
      },
    });
}

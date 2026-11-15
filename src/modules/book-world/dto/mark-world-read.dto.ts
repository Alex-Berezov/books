import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601, ValidateIf } from 'class-validator';

/**
 * Тело «прочитано» сущности (решение арбитра `F08 | F08-1` R5): `autoTextAt`, который редактор видел
 * на вкладке. Под замком сверяется с текущим: другой (или `null` при записанном тексте) — 409
 * `WORLD_TEXT_CHANGED`; текста модели нет вовсе — 409 `AUTO_TEXT_NONE`.
 */
export class MarkWorldReadDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'autoTextAt the editor saw; another one - 409 WORLD_TEXT_CHANGED; no model text at all - 409 AUTO_TEXT_NONE',
  })
  @ValidateIf((_o, value) => value !== null)
  @IsISO8601({ strict: true })
  autoTextAt!: string | null;
}

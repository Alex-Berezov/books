import { ApiProperty } from '@nestjs/swagger';
import { IsDefined, IsString, ValidateIf } from 'class-validator';
import { RICH_HTML_MAX_LENGTH, RichHtml } from '../../../shared/validators/rich-html.decorator';

/**
 * Очень краткий пересказ (F04 T1). Ключ обязателен: `{}` — 400, а `null` и `""` очищают поле
 * (решение арбитра `F04 | F04-1`): пустое тело — ошибка клиента, молчаливое стирание не вернуть.
 * `ValidateIf` стоит выше `IsDefined`, иначе `null` отбивался бы как отсутствующий ключ.
 */
export class UpdateBookSummaryBriefDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Very short summary (rich HTML, 3-5 min read); null or "" clears it',
  })
  @ValidateIf((_o, value) => value !== null)
  @IsDefined()
  @IsString()
  @RichHtml(RICH_HTML_MAX_LENGTH.text)
  brief!: string | null;
}

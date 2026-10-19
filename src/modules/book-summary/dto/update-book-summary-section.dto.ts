import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDefined, IsInt, Max, Min, ValidateIf } from 'class-validator';
import { IsIsoDateTimeWithZone } from '../../../shared/validators/iso-date-time-with-zone.decorator';
import {
  BookSummarySectionTextDto,
  READER_CHAPTER_API,
  SUMMARY_SECTION_LIMITS,
} from './create-book-summary-section.dto';

/**
 * Правка раздела по `id` (T5): раздел пишется целиком. `readerChapter` обязателен: `null` снимает
 * связь с главой, а нет ключа — 400, а не молча снятая связь (решение арбитра `F04 | F04-1`, шаг 7
 * после круга 3, как `brief`). `expectedUpdatedAt` — `updatedAt`, который видела вкладка; раздел
 * успел поправить другой редактор — 409.
 */
export class UpdateBookSummarySectionDto extends BookSummarySectionTextDto {
  @ApiProperty(READER_CHAPTER_API)
  @ValidateIf((_o, value) => value !== null)
  @IsDefined()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SUMMARY_SECTION_LIMITS.readerChapter)
  readerChapter!: number | null;

  @ApiProperty({ type: String, format: 'date-time' })
  @IsIsoDateTimeWithZone()
  expectedUpdatedAt!: string;
}

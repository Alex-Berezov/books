import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { SummarySectionIds } from './summary-section-ids.decorator';

/** Удаление раздела: `from` — порядок разделов, который видела вкладка (T5). */
export class DeleteBookSummarySectionDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID('all')
  sectionId!: string;

  @ApiProperty({ type: [String], description: 'Section ids in the order the editor saw' })
  @SummarySectionIds()
  from!: string[];
}

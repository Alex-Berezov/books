import { ApiProperty } from '@nestjs/swagger';
import { SummarySectionIds } from './summary-section-ids.decorator';

/** Перестановка разделов: `from` — порядок, который видела вкладка, `to` — новый порядок (T5). */
export class ReorderBookSummarySectionsDto {
  @ApiProperty({ type: [String], description: 'Section ids in the order the editor saw' })
  @SummarySectionIds()
  from!: string[];

  @ApiProperty({ type: [String], description: 'The same ids in the new order' })
  @SummarySectionIds()
  to!: string[];
}

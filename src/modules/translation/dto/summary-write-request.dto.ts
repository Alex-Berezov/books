import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { Trim } from '../../../shared/validators/trim.decorator';
import { REGEN_REMARK_MAX } from '../summary-write/summary-write.constants';

/** Тела запросов хода пересказа `F06-2` (`features/F06-summary-autofill/tech.md` §6). */

export class RegenerateSummaryItemDto {
  @ApiPropertyOptional({
    type: String,
    maxLength: REGEN_REMARK_MAX,
    description: 'What the editor asks to change: it goes to the author prompt',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(REGEN_REMARK_MAX)
  remark?: string;
}

export class AcceptSummaryItemDto {
  @ApiPropertyOptional({
    type: Boolean,
    description: 'The editor confirmed that the section moves to other reader chapters',
  })
  @IsOptional()
  @IsBoolean()
  confirmChapterChange?: boolean;
}

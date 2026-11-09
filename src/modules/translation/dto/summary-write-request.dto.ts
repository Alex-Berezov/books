import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { Trim } from '../../../shared/validators/trim.decorator';
import { REGEN_REMARK_MAX } from '../summary-write/summary-write.constants';

/** Тела запросов хода пересказа `F06-2` (`features/F06-summary-autofill/tech.md` §6). */

/** Длина отпечатка предложения: шестнадцатеричный sha256. */
const EXPECTED_PRINT_MAX = 64;

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

  @ApiPropertyOptional({
    type: String,
    maxLength: EXPECTED_PRINT_MAX,
    description:
      'Analysis run only: the print of the proposal the editor looked at (`print` of GET items/:index); another proposal now - 409 ANALYSIS_PROPOSAL_CHANGED. Absent - no check',
  })
  // Не `@IsOptional`: он пропустил бы `null`, а `null` - не «поля нет» и сверку не снимает.
  @ValidateIf((_dto, value) => value !== undefined)
  @IsString()
  @MaxLength(EXPECTED_PRINT_MAX)
  expectedPrint?: string;
}

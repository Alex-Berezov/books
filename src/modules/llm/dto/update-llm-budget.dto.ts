import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Matches, ValidateIf } from 'class-validator';
import { MONEY_DOC, MONEY_PATTERN, notUndefined, toMoneyString } from './llm-money';

export class UpdateLlmBudgetDto {
  @ApiPropertyOptional({
    ...MONEY_DOC,
    description: 'Spending ceiling for all operations; 0 stops every call',
  })
  @ValidateIf(notUndefined)
  @Transform(toMoneyString)
  @Matches(MONEY_PATTERN, {
    message: 'ceilingUsd must be a non-negative amount with up to 8 decimals',
  })
  ceilingUsd?: string;

  @ApiPropertyOptional({
    ...MONEY_DOC,
    description: 'Default limit offered in the run dialog; may exceed the ceiling',
  })
  @ValidateIf(notUndefined)
  @Transform(toMoneyString)
  @Matches(MONEY_PATTERN, {
    message: 'defaultRunLimitUsd must be a non-negative amount with up to 8 decimals',
  })
  defaultRunLimitUsd?: string;
}

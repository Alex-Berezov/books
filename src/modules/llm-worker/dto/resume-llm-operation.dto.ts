import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Matches, ValidateIf } from 'class-validator';
import { MONEY_DOC, MONEY_PATTERN, notUndefined, toMoneyString } from '../../llm/dto/llm-money';

export class ResumeLlmOperationDto {
  @ApiPropertyOptional({
    ...MONEY_DOC,
    description: 'New operation limit; not below spent + reserved. Omitted - the limit stays',
  })
  @ValidateIf(notUndefined)
  @Transform(toMoneyString)
  @Matches(MONEY_PATTERN, {
    message: 'limitUsd must be a non-negative amount with up to 8 decimals',
  })
  limitUsd?: string;
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Matches, ValidateIf } from 'class-validator';
import { MONEY_DOC, MONEY_PATTERN, notUndefined, toMoneyString } from '../../llm/dto/llm-money';

export class StartDossierDto {
  @ApiPropertyOptional({
    ...MONEY_DOC,
    description: 'Limit of the dossier operation; default - the estimate × 1.5',
  })
  @ValidateIf(notUndefined)
  @Transform(toMoneyString)
  @Matches(MONEY_PATTERN, {
    message: 'limitUsd must be a non-negative amount with up to 8 decimals',
  })
  limitUsd?: string;
}

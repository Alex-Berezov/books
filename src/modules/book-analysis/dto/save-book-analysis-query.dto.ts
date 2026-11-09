import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { ExpectedRowQueryDto } from '../../../shared/dto/expected-updated-at-query.dto';

export class SaveBookAnalysisQueryDto extends ExpectedRowQueryDto {
  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description:
      'Validate and merge exactly as a save would, write nothing, return hasCore and warnings (decision A3); expectedUpdatedAt and expectedAbsent are not checked',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  dryRun?: 'true' | 'false';
}

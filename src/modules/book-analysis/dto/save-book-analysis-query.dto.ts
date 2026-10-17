import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export class SaveBookAnalysisQueryDto {
  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description:
      'Validate and merge exactly as a save would, write nothing, return hasCore and warnings (decision A3)',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  dryRun?: 'true' | 'false';
}

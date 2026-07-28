import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class LiftClaimBlockDto {
  @ApiProperty({ description: 'Why the temporary block is being lifted' })
  @IsString()
  liftReasonRu!: string;
}

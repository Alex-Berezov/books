import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { RightsClaimStatus } from '../rights-claim-interface';

export class ChangeRightsClaimStatusDto {
  @ApiProperty({ enum: RightsClaimStatus })
  @IsEnum(RightsClaimStatus)
  status!: RightsClaimStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notesRu?: string;
}

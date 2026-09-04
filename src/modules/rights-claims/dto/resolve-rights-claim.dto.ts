import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString } from 'class-validator';
import { RightsClaimResolution, RightsClaimStatus } from '../rights-claim-interface';

export class ResolveRightsClaimDto {
  @ApiProperty({ enum: RightsClaimResolution })
  @IsEnum(RightsClaimResolution)
  resolution!: RightsClaimResolution;

  @ApiProperty()
  @IsString()
  resolutionNotesRu!: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Lift every active access block of the claim',
  })
  @IsOptional()
  @IsBoolean()
  liftActiveBlocks?: boolean;

  @ApiPropertyOptional({
    enum: [RightsClaimStatus.RESOLVED_VALID, RightsClaimStatus.RESOLVED_INVALID],
    description: 'Overrides the status derived from the resolution',
  })
  @IsOptional()
  @IsIn([RightsClaimStatus.RESOLVED_VALID, RightsClaimStatus.RESOLVED_INVALID])
  finalStatus?:
    | (typeof RightsClaimStatus)['RESOLVED_VALID']
    | (typeof RightsClaimStatus)['RESOLVED_INVALID'];
}

export class ReopenRightsClaimDto {
  @ApiProperty()
  @IsString()
  reasonRu!: string;
}

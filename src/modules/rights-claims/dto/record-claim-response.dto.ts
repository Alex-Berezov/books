import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import { RightsClaimChannel } from '../rights-claim-interface';

export class RecordClaimResponseDto {
  @ApiProperty({ description: 'Text of the answer sent to the claimant' })
  @IsString()
  responseTextRu!: string;

  @ApiPropertyOptional({ enum: RightsClaimChannel })
  @IsOptional()
  @IsEnum(RightsClaimChannel)
  responseChannel?: RightsClaimChannel;

  @ApiPropertyOptional({ description: 'ISO date the answer was sent; defaults to now' })
  @IsOptional()
  @IsDateString()
  responseSentAt?: string;
}

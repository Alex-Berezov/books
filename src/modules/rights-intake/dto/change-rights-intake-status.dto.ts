import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { RightsIntakeStatus } from '@prisma/client';

export class ChangeRightsIntakeStatusDto {
  @ApiProperty({ description: 'New status', enum: RightsIntakeStatus })
  @IsEnum(RightsIntakeStatus)
  status!: RightsIntakeStatus;
}

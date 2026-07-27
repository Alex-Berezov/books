import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RevokeRightsLicenseDto {
  @ApiProperty({ example: 'Правообладатель расторг договор.' })
  @IsString()
  @IsNotEmpty()
  reasonRu!: string;
}

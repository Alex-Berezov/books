import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString } from 'class-validator';

export class ReorderBookVersionContributorsDto {
  @ApiProperty({
    description: 'Array of BookVersionContributor IDs in desired order',
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  contributorIds!: string[];
}

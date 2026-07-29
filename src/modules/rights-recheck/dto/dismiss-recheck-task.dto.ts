import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class DismissRecheckTaskDto {
  @ApiProperty({ description: 'Why the task does not apply. Mandatory — dismissals are audited.' })
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reasonRu!: string;
}

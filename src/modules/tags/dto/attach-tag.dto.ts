import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class AttachTagDto {
  @ApiProperty({ description: 'Tag ID' })
  @IsString()
  tagId!: string;
}

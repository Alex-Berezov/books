import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class AttachTagDto {
  @ApiProperty({ description: 'ID тега' })
  @IsString()
  tagId!: string;
}

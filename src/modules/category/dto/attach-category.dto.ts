import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class AttachCategoryDto {
  @ApiProperty({ description: 'ID категории' })
  @IsString()
  categoryId!: string;
}

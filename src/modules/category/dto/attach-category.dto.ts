import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class AttachCategoryDto {
  @ApiProperty({ description: 'Category ID' })
  @IsString()
  categoryId!: string;
}

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateCommentDto {
  @ApiPropertyOptional({ description: 'Updated text' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  text?: string;

  @ApiPropertyOptional({ description: 'Moderation: hide/show' })
  @IsOptional()
  @IsBoolean()
  isHidden?: boolean;
}

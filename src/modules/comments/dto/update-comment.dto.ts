import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { COMMENT_TEXT_MAX_LENGTH } from '../../../shared/constants/validation';

export class UpdateCommentDto {
  @ApiPropertyOptional({ description: 'Updated text', maxLength: COMMENT_TEXT_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(COMMENT_TEXT_MAX_LENGTH)
  text?: string;

  @ApiPropertyOptional({ description: 'Moderation: hide/show' })
  @IsOptional()
  @IsBoolean()
  isHidden?: boolean;
}

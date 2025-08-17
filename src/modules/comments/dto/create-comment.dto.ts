import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class CreateCommentDto {
  @ApiPropertyOptional({ description: 'BookVersion ID' })
  @IsOptional()
  @IsUUID()
  bookVersionId?: string;

  @ApiPropertyOptional({ description: 'Chapter ID' })
  @IsOptional()
  @IsUUID()
  chapterId?: string;

  @ApiPropertyOptional({ description: 'AudioChapter ID' })
  @IsOptional()
  @IsUUID()
  audioChapterId?: string;

  @ApiPropertyOptional({ description: 'Parent comment ID (for replies)' })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiProperty({ description: 'Comment text' })
  @IsString()
  @MinLength(1)
  text!: string;
}

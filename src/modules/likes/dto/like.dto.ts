import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export class LikeRequestDto {
  @ApiPropertyOptional({ description: 'ID of comment to like', nullable: true })
  @IsOptional()
  @IsString()
  commentId?: string;

  @ApiPropertyOptional({ description: 'ID of book version to like', nullable: true })
  @IsOptional()
  @IsString()
  bookVersionId?: string;
}

export class LikeCountQueryDto {
  @ApiProperty({ enum: ['comment', 'bookVersion'] })
  @IsIn(['comment', 'bookVersion'])
  target!: 'comment' | 'bookVersion';

  @ApiProperty()
  @IsString()
  targetId!: string;
}

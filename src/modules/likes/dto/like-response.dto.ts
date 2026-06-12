import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class LikeDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  userId!: string;

  @ApiPropertyOptional({ nullable: true })
  bookVersionId?: string;

  @ApiPropertyOptional({ nullable: true })
  commentId?: string;

  @ApiProperty()
  isLike!: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date | string;
}

export class LikeCountDto {
  @ApiProperty()
  likes!: number;

  @ApiProperty()
  dislikes!: number;

  @ApiPropertyOptional()
  count?: number;
}

export class ToggleLikeResponseDto {
  @ApiProperty()
  liked!: boolean;

  @ApiProperty()
  isLike!: boolean;

  @ApiProperty()
  likes!: number;

  @ApiProperty()
  dislikes!: number;
}

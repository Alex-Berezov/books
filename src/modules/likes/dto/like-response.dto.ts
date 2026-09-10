import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class LikeDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  userId!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  bookVersionId?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  commentId?: string;

  @ApiProperty({ type: Boolean })
  isLike!: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date | string;
}

export class LikeCountDto {
  @ApiProperty({ type: Number })
  likes!: number;

  @ApiProperty({ type: Number })
  dislikes!: number;

  @ApiPropertyOptional({ type: Number })
  count?: number;
}

export class ToggleLikeResponseDto {
  @ApiProperty({ type: Boolean })
  liked!: boolean;

  @ApiProperty({ type: Boolean })
  isLike!: boolean;

  @ApiProperty({ type: Number })
  likes!: number;

  @ApiProperty({ type: Number })
  dislikes!: number;
}

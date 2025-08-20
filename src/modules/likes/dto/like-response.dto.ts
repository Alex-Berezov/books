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

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date | string;
}

export class LikeCountDto {
  @ApiProperty()
  count!: number;
}

export class ToggleLikeResponseDto {
  @ApiProperty()
  liked!: boolean;

  @ApiProperty()
  count!: number;
}

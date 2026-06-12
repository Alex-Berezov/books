import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CommentUserDto } from './comment-user.dto';

export class CommentDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ nullable: true })
  parentId?: string | null;

  @ApiProperty({ nullable: true })
  bookVersionId?: string | null;

  @ApiProperty({ nullable: true })
  chapterId?: string | null;

  @ApiProperty({ nullable: true })
  audioChapterId?: string | null;

  @ApiProperty({ nullable: true })
  ratingId?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Rating score associated with this review (1-5)',
  })
  ratingScore?: number | null;

  @ApiProperty()
  text!: string;

  @ApiProperty()
  isHidden!: boolean;

  @ApiProperty()
  isDeleted!: boolean;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;

  @ApiProperty({ type: CommentUserDto })
  user!: CommentUserDto;

  @ApiProperty({ type: () => [CommentDto] })
  children!: CommentDto[];
}

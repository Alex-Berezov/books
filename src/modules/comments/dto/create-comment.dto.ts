import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  MaxLength,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Xor } from '../../../shared/validators/xor.decorator';
import { ExactlyOne } from '../../../shared/validators/exactly-one.decorator';
import {
  COMMENT_TEXT_MAX_LENGTH,
  msgExactlyOne,
  msgExactlyOneOf,
} from '../../../shared/constants/validation';

export class CreateCommentDto {
  // Internal validator anchor to enforce exactly-one among target fields
  @ExactlyOne(['bookVersionId', 'chapterId', 'audioChapterId'], {
    message: msgExactlyOneOf(['bookVersionId', 'chapterId', 'audioChapterId']),
  })
  private readonly _targetChoice?: unknown;

  @ApiPropertyOptional({ description: 'BookVersion ID' })
  @IsOptional()
  @IsUUID()
  @ExactlyOne(['bookVersionId', 'chapterId', 'audioChapterId'])
  @Xor('bookVersionId', 'chapterId', {
    message: msgExactlyOne('bookVersionId', 'chapterId'),
  })
  bookVersionId?: string;

  @ApiPropertyOptional({ description: 'Chapter ID' })
  @IsOptional()
  @IsUUID()
  @ExactlyOne(['bookVersionId', 'chapterId', 'audioChapterId'])
  @Xor('chapterId', 'audioChapterId', {
    message: msgExactlyOne('chapterId', 'audioChapterId'),
  })
  chapterId?: string;

  @ApiPropertyOptional({ description: 'AudioChapter ID' })
  @IsOptional()
  @IsUUID()
  @ExactlyOne(['bookVersionId', 'chapterId', 'audioChapterId'])
  audioChapterId?: string;

  @ApiPropertyOptional({ description: 'Parent comment ID (for replies)' })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiProperty({ description: 'Comment text', maxLength: COMMENT_TEXT_MAX_LENGTH })
  @IsString()
  @MinLength(1)
  @MaxLength(COMMENT_TEXT_MAX_LENGTH)
  text!: string;

  @ApiPropertyOptional({ description: 'Book rating score (1-5)', minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import { Xor } from '../../../shared/validators/xor.decorator';
import { ExactlyOne } from '../../../shared/validators/exactly-one.decorator';
import { msgExactlyOne, msgExactlyOneOf } from '../../../shared/constants/validation';

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

  @ApiProperty({ description: 'Comment text' })
  @IsString()
  @MinLength(1)
  text!: string;
}

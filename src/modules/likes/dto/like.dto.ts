import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { Xor } from '../../../shared/validators/xor.decorator';
import { msgExactlyOne } from '../../../shared/constants/validation';

export class LikeRequestDto {
  @ApiPropertyOptional({ description: 'ID of comment to like', nullable: true })
  @IsOptional()
  @IsString()
  @Xor('commentId', 'bookVersionId', { message: msgExactlyOne('commentId', 'bookVersionId') })
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

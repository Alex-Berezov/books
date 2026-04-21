import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

export class ReorderAudioChaptersDto {
  @ApiProperty({
    description: 'Ordered list of audio chapter ids. Number is reassigned by position (1-based).',
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  audioChapterIds!: string[];
}

import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { PaginationDto } from '../../../shared/dto/pagination.dto';

export class ListCommentsQueryDto extends PaginationDto {
  @ApiProperty({ enum: ['version', 'chapter', 'audio'] })
  @IsString()
  @IsIn(['version', 'chapter', 'audio'])
  target!: 'version' | 'chapter' | 'audio';

  @ApiProperty()
  @IsString()
  @IsUUID()
  targetId!: string;

  @IsOptional()
  declare page?: number;

  @IsOptional()
  declare limit?: number;
}

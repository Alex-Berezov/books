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

  @ApiProperty({ enum: ['date', 'popularity'], default: 'date', required: false })
  @IsOptional()
  @IsIn(['date', 'popularity'])
  sortBy?: 'date' | 'popularity' = 'date';

  @IsOptional()
  declare page?: number;

  @IsOptional()
  declare limit?: number;
}

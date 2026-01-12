import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../../shared/dto/pagination.dto';

export class ListTagsDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Search query' })
  @IsOptional()
  @IsString()
  q?: string;
}

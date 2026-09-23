import { ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../../shared/dto/pagination.dto';

export class ListTagsDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Search query' })
  @IsOptional()
  @IsString()
  q?: string;

  /**
   * Read from `query.lang` by `GET /admin/tags` (`TagsController.adminList`).
   * Declared here because the global validation pipe runs with
   * `forbidNonWhitelisted`, so an undeclared query property makes the whole
   * request fail with 400 instead of being ignored.
   */
  @ApiPropertyOptional({ enum: Language, description: 'Language for per-language counters' })
  @IsOptional()
  @IsEnum(Language)
  lang?: Language;
}

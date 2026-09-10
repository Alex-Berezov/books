import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CategoryType } from '@prisma/client';

/**
 * Response DTO — только Swagger (`STYLE_GUIDE.md` §7). Один узел пути от корня
 * к родителю термина, как его собирает `CategoryService.getAncestors` /
 * `CategoryTreeService.collectAncestors` — сам термин (`id` из параметра
 * маршрута) в путь не входит.
 */
export class CategoryAncestorDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: String })
  slug!: string;

  @ApiProperty({ enum: CategoryType })
  type!: CategoryType;

  @ApiPropertyOptional({ type: String, nullable: true })
  parentId?: string | null;
}

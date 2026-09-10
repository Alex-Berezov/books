import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CategoryType } from '@prisma/client';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 * Поля зеркалят модель `Category` (`prisma/schema.prisma`) один в один: запись
 * идёт без `select`/`include`, поэтому связи (`parent`, `children`,
 * `translations`, `books`) сюда не входят.
 *
 * Используется на `POST /categories`, `PATCH /categories/:id` и
 * `DELETE /categories/:id` — во всех трёх местах `CategoryService` возвращает
 * ровно эту форму (`create`/`update`/`remove` пишут через `tx.category.*`
 * без выборки полей).
 */
export class CategoryEntityDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ enum: CategoryType })
  type!: CategoryType;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: String })
  slug!: string;

  @ApiProperty({ type: String })
  key!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  parentId?: string | null;

  @ApiProperty({ type: Boolean, default: true })
  indexable!: boolean;

  @ApiProperty({ type: Boolean, default: true })
  isVisible!: boolean;

  @ApiProperty({ type: Number, default: 0 })
  sortOrder!: number;
}

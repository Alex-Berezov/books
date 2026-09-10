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
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: CategoryType })
  type!: CategoryType;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  key!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  parentId?: string | null;

  @ApiProperty({ default: true })
  indexable!: boolean;

  @ApiProperty({ default: true })
  isVisible!: boolean;

  @ApiProperty({ default: 0 })
  sortOrder!: number;
}

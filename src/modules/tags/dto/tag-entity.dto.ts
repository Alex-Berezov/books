import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 * Поля зеркалят модель `Tag` (`prisma/schema.prisma`) один в один: запись
 * идёт без `select`/`include`, связи (`translations`, `books`) сюда не входят.
 *
 * Используется на `POST /tags`, `PATCH /tags/:id` и `DELETE /tags/:id` —
 * во всех трёх местах `TagsService` возвращает ровно эту форму
 * (`create`/`update`/`remove` пишут через `prisma.tag.*`/`tx.tag.*` без
 * выборки полей).
 */
export class TagEntityDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: String })
  slug!: string;

  @ApiProperty({ type: String })
  key!: string;

  @ApiProperty({ type: Boolean, default: true })
  indexable!: boolean;

  @ApiProperty({ type: Boolean, default: true })
  isVisible!: boolean;

  @ApiProperty({ type: Number, default: 0 })
  sortOrder!: number;
}

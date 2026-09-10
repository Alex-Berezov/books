import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO — только Swagger (`STYLE_GUIDE.md` §7). Поля зеркалят модель
 * `BookCategory` (`prisma/schema.prisma`) один в один.
 *
 * `POST /versions/:id/categories` (`CategoryService.attachCategoryToVersion`)
 * отдаёт ровно эту форму — найденную после привязки строку связи книжной
 * версии с категорией (`prisma.bookCategory.findFirst`), без выборки полей.
 */
export class VersionCategoryLinkDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  bookVersionId!: string;

  @ApiProperty({ type: String })
  categoryId!: string;

  @ApiProperty({ type: Boolean, default: false })
  isPrimary!: boolean;

  @ApiProperty({ type: Number, default: 0 })
  sortOrder!: number;
}

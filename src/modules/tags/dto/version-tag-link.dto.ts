import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO — только Swagger (`STYLE_GUIDE.md` §7). Поля зеркалят модель
 * `BookTag` (`prisma/schema.prisma`) один в один.
 *
 * `POST /versions/:id/tags` (`TagsService.attach`) отдаёт ровно эту форму —
 * найденную после привязки строку связи книжной версии с тегом
 * (`prisma.bookTag.findFirst`), без выборки полей.
 */
export class VersionTagLinkDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  bookVersionId!: string;

  @ApiProperty({ type: String })
  tagId!: string;
}

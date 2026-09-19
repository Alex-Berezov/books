import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO — только Swagger (`STYLE_GUIDE.md` §7).
 *
 * `POST /versions/:id/categories` (`CategoryService.attachCategoryToVersion`)
 * отдаёт найденную после привязки строку связи книжной версии с категорией
 * по белому списку полей (`prisma.bookCategory.findFirst` с `select`).
 *
 * 🔴 `LEGACY-005`. Поле `isPrimary` снято из ответа релизом 1 (`v1.0.97`). Частичный
 * индекс колонки снят миграцией `20260919120000_legacy_005_drop_isprimary_index`, само
 * поле ушло из клиента под `@ignore`, а `DROP COLUMN` уедет следующим тегом (`ADR-018`,
 * расширение перед сжатием). Главную категорию версии держит
 * `BookVersion.primaryCategoryId`. Форма DTO больше не зеркалит модель один в один —
 * она зеркалит белый список сервиса, и это намеренно.
 *
 * ⚠️ «Выбирает» здесь шире, чем «читает»: `create`, `delete` и `upsert` возвращают
 * запись через `RETURNING`, а `include` на связи тянет её скаляры. Перечень всех
 * обращений к модели заморожен сканирующей спекой
 * `src/common/testing/book-category-select.spec.ts` — ей, а не этому докблоку, верить
 * о том, выбирает колонку кто-нибудь или нет.
 */
export class VersionCategoryLinkDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  bookVersionId!: string;

  @ApiProperty({ type: String })
  categoryId!: string;

  @ApiProperty({ type: Number, default: 0 })
  sortOrder!: number;
}

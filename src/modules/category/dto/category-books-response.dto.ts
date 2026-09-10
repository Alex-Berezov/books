import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import { PublicBookVersionDto } from '../../book/dto/book-detail-response.dto';
import { SeoResponseDto } from '../../seo/dto/seo-response.dto';
import { TagEntityDto } from '../../tags/dto/tag-entity.dto';
import { TagTranslationDto } from '../../tags/dto/tag-translation-entity.dto';
import { CategoryEntityDto } from './category-entity.dto';
import { CategoryTranslationEntityDto } from './category-translation-entity.dto';
import { PaginationMeta } from './category-response.dto';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 *
 * Тег версии книги вместе со всеми своими переводами:
 * `CategoryService.getBySlugWithBooks` читает их как
 * `tags: { select: { tag: { include: { translations: true } } } }`
 * (`category.service.ts:538-547`), то есть колонки `Tag` плюс полные строки
 * `TagTranslation` без связей `tag`/`seo`.
 */
export class CategoryBookTagDto extends TagEntityDto {
  @ApiProperty({ type: TagTranslationDto, isArray: true })
  translations!: TagTranslationDto[];
}

/**
 * Строка связи `BookTag`, как она приезжает в ответе: `select` берёт из неё
 * только вложенный `tag`, собственных полей связи в ответе нет.
 */
export class CategoryBookTagLinkDto {
  @ApiProperty({ type: CategoryBookTagDto })
  tag!: CategoryBookTagDto;
}

/**
 * Опубликованная версия книги в выдаче категории: белый список
 * `PUBLIC_BOOK_VERSION_SELECT` (`src/common/selects/public-book.select.ts`)
 * плюс теги со связью.
 */
export class CategoryBookVersionDto extends PublicBookVersionDto {
  @ApiProperty({ type: CategoryBookTagLinkDto, isArray: true })
  tags!: CategoryBookTagLinkDto[];
}

/**
 * Книга в выдаче категории: поля `PUBLIC_BOOK_SELECT` (только
 * `id`/`slug`/`createdAt`/`updatedAt`), опубликованные версии и средняя оценка.
 */
export class CategoryBookDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String })
  slug!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: CategoryBookVersionDto, isArray: true })
  versions!: CategoryBookVersionDto[];

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Average rating (0-5) over this book alone, null when nobody rated it',
  })
  rating!: number | null;
}

/**
 * Перевод категории, как он лежит в `category.translation`: запись прочитана
 * с `include: { category: true, seo: true }` и кладётся в ответ целиком
 * (`category.service.ts:505-508`, `:579-584`), поэтому вместе со своими
 * колонками несёт и раскрытую связь `category`.
 *
 * ⚠️ Связь `category` здесь не срезана — в отличие от языкового близнеца
 * `getByLangSlugWithBooks`, который выбрасывает ключ деструктуризацией, так что
 * до клиента `category` не доходит вовсе и в его схеме не описана.
 */
export class CategoryBooksTranslationDto extends CategoryTranslationEntityDto {
  @ApiProperty({ type: CategoryEntityDto })
  category!: CategoryEntityDto;
}

/**
 * Поле `category` ответа: строка `Category` целиком плюс выбранный перевод
 * и его описание, поднятое на верхний уровень для удобства фронта.
 *
 * `translation` — `null`, когда перевода на запрошенный язык нет и категория
 * найдена запасным поиском по базовому слагу.
 */
export class CategoryBooksCategoryDto extends CategoryEntityDto {
  @ApiPropertyOptional({ type: CategoryBooksTranslationDto, nullable: true })
  translation!: CategoryBooksTranslationDto | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Shortcut for translation.description',
  })
  description!: string | null;
}

/**
 * Ответ `GET /categories/:slug/books` (`CategoryController.publicBySlug` →
 * `CategoryService.getBySlugWithBooks`, `category.service.ts:497-595`).
 *
 * ⚠️ `meta` здесь не пагинация, а её форма: сервис отдаёт все подходящие книги
 * одним куском и заполняет `page: 1`, `limit: 100`, `totalPages: 1` константами.
 */
export class CategoryBooksResponseDto {
  @ApiProperty({ type: CategoryBooksCategoryDto })
  category!: CategoryBooksCategoryDto;

  @ApiPropertyOptional({ type: SeoResponseDto, nullable: true })
  seo!: SeoResponseDto | null;

  @ApiProperty({ type: CategoryBookDto, isArray: true })
  data!: CategoryBookDto[];

  @ApiProperty({ type: PaginationMeta })
  meta!: PaginationMeta;

  @ApiProperty({
    enum: Language,
    isArray: true,
    description: 'Languages that have at least one published version in this category',
  })
  availableLanguages!: Language[];
}

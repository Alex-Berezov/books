import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import { PublicBookVersionDto } from '../../book/dto/book-detail-response.dto';
import { SeoResponseDto } from '../../seo/dto/seo-response.dto';
import { TagEntityDto } from './tag-entity.dto';
import { TagTranslationDto } from './tag-translation-entity.dto';

/**
 * `TagsService.versionsByTagSlug` reads `trans` with
 * `include: { tag: true, seo: true }` and assigns it to `tag.translation`
 * via `(trans as TagTranslation) ?? null` — the cast narrows the *declared*
 * return type, but the value handed to `JSON.stringify` on the wire still
 * carries the nested `tag`/`seo` relations.
 *
 * ⚠️ Один класс на модель. `versionsByTagLangSlug` (`GET /:lang/tags/:slug/books`,
 * `public/dto/public-tag-books-response.dto.ts`) читает перевод тем же
 * `include`, поэтому переиспользует этот же класс, а не описывает форму заново:
 * `@nestjs/swagger` именует схему по имени класса, и второй класс с тем же
 * именем молча вытеснил бы первый из `components.schemas`.
 */
export class TagTranslationWithRelationsDto extends TagTranslationDto {
  @ApiProperty({ type: TagEntityDto })
  tag!: TagEntityDto;

  @ApiPropertyOptional({ type: SeoResponseDto, nullable: true })
  seo?: SeoResponseDto | null;
}

/**
 * Тег вместе с переводом на разрешённый язык — форма поля `tag` в ответах
 * `GET /tags/:slug/books` и `GET /:lang/tags/:slug/books` (обе ручки собирают
 * его из одних и тех же полей `Tag` плюс найденный перевод).
 */
export class TagWithTranslationDto extends TagEntityDto {
  @ApiPropertyOptional({ type: TagTranslationWithRelationsDto, nullable: true })
  translation?: TagTranslationWithRelationsDto | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  description?: string | null;
}

/**
 * SEO-заголовок и описание версии книги, как их видит публичная выдача тега.
 * Соответствует инлайновому типу
 * `{ metaTitle: string | null; metaDescription: string | null }` в сигнатурах
 * `TagsService.versionsByTagSlug` и `versionsByTagLangSlug`
 * (`select: { metaTitle: true, metaDescription: true }` на самом запросе версии —
 * здесь, в отличие от `tag.translation`, сужение совпадает с реальной выборкой).
 */
export class TagBookVersionSeoDto {
  @ApiPropertyOptional({ type: String, nullable: true })
  metaTitle?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  metaDescription?: string | null;
}

/**
 * Версия книги в публичной выдаче тега — белый список
 * `PUBLIC_BOOK_VERSION_SELECT` (`src/common/selects/public-book.select.ts`),
 * уже описанный классом `PublicBookVersionDto`, плюс `rating` и `seo`,
 * добавленные поверх выборки.
 *
 * ⚠️ Поля белого списка не перечисляются здесь заново: список правится в одном
 * месте, и наследование не даёт схеме отстать от него молча. Форма одна на обе
 * ручки — `GET /tags/:slug/books` и `GET /:lang/tags/:slug/books`.
 *
 * `rating` и `seo` объявлены обязательными и обнуляемыми, а не необязательными:
 * оба ключа сервис кладёт всегда — `rating: ratingMap.get(v.bookId) ?? null`
 * (`tags.service.ts`, `enriched`/`data`), `seo` приходит тем же `select`, что и
 * поля белого списка. «Может отсутствовать» было бы неправдой о форме ответа.
 */
export class PublicTagBookVersionDto extends PublicBookVersionDto {
  @ApiProperty({
    type: Number,
    description: 'Average rating (0-5) of the book',
    nullable: true,
  })
  rating!: number | null;

  @ApiProperty({ type: TagBookVersionSeoDto, nullable: true })
  seo!: TagBookVersionSeoDto | null;
}

/**
 * `GET /tags/:slug/books` (`TagsController.publicBySlug` →
 * `TagsService.versionsByTagSlug`). Публичный список опубликованных версий
 * книг по слагу тега, без языкового префикса (аналог `GET /:lang/tags/:slug/books`,
 * но без пагинации).
 */
export class TagBooksBySlugResponseDto {
  @ApiProperty({ type: TagWithTranslationDto })
  tag!: TagWithTranslationDto;

  /** Ключ есть в ответе всегда: `seo: trans?.seo ?? null` в `versionsByTagSlug`. */
  @ApiProperty({ type: SeoResponseDto, nullable: true })
  seo!: SeoResponseDto | null;

  @ApiProperty({ type: [PublicTagBookVersionDto] })
  versions!: PublicTagBookVersionDto[];

  @ApiProperty({ enum: Language, isArray: true })
  availableLanguages!: Language[];
}

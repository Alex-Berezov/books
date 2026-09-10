import { ApiProperty } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import { BookCardsPaginationDto } from '../../book/dto/paged-book-cards.dto';
import { SeoResponseDto } from '../../seo/dto/seo-response.dto';
import {
  PublicTagBookVersionDto,
  TagWithTranslationDto,
} from '../../tags/dto/tag-books-by-slug-response.dto';

/**
 * Response of `GET /:lang/tags/:slug/books` (`TagsService.versionsByTagLangSlug`).
 *
 * ⚠️ Вложенные формы — `tag`, `tag.translation`, элемент `data` — не описываются
 * здесь заново: их отдаёт тот же `TagsService` тем же запросом, что и на
 * `GET /tags/:slug/books`, поэтому классы берутся из модуля-владельца
 * (`tags/dto/tag-books-by-slug-response.dto.ts`). Копия под своим именем была бы
 * вторым описанием одной модели, а копия под тем же именем молча вытеснила бы
 * оригинал из `components.schemas`: `@nestjs/swagger` именует схему по имени
 * класса.
 *
 * От соседней ручки этот ответ отличается только конвертом: `data` + `meta`
 * вместо `versions`, потому что здесь есть пагинация.
 */
export class PublicTagBooksResponseDto {
  @ApiProperty({ type: TagWithTranslationDto })
  tag!: TagWithTranslationDto;

  /** Ключ есть в ответе всегда: `seo: trans?.seo ?? null` в `versionsByTagLangSlug`. */
  @ApiProperty({ type: SeoResponseDto, nullable: true })
  seo!: SeoResponseDto | null;

  @ApiProperty({ type: [PublicTagBookVersionDto] })
  data!: PublicTagBookVersionDto[];

  @ApiProperty({ type: BookCardsPaginationDto })
  meta!: BookCardsPaginationDto;

  @ApiProperty({ enum: Language, isArray: true })
  availableLanguages!: Language[];
}

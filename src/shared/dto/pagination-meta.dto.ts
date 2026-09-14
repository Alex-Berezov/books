import { ApiProperty } from '@nestjs/swagger';

/**
 * Конверт публичной списочной формы `{data, meta}`.
 *
 * Живёт отдельно от `PaginationInfoDto` (`paginated-response.dto.ts`) не по недосмотру: форм
 * списочного ответа в проекте две, и они разведены сознательно (`LEGACY-177`, 13.09.2026).
 * За логином — `{items, pagination}`; публичные маршруты остались на `{data, meta}`, потому что
 * их ответы лежат в edge-кэше Cloudflare и смена формы требует сброса кэша на боевом домене.
 * Перевод публичных списков ведёт запись `LEGACY-378` и решается владельцем.
 *
 * 🔴 Класс один на оба модуля намеренно. До 14.09.2026 он был объявлен дважды — в
 * `category/dto/category-response.dto.ts` и `tags/dto/tag-response.dto.ts`, побайтово одинаково.
 * Swagger именует схему по имени класса, поэтому второй молча вытеснял первого из
 * `components.schemas`; пока формы совпадали, это было незаметно, а разойдись они — из документа
 * пропала бы одна из двух, и сторож схемы ответа сверял бы маршрут с чужой формой
 * (`LEGACY-016`). Уникальность имён теперь стережёт `src/common/testing/dto-name-uniqueness.spec.ts`.
 */
export class PaginationMeta {
  @ApiProperty({ type: Number })
  page: number;

  @ApiProperty({ type: Number })
  limit: number;

  @ApiProperty({ type: Number })
  total: number;

  @ApiProperty({ type: Number })
  totalPages: number;
}

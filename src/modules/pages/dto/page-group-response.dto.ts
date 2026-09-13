import { ApiProperty } from '@nestjs/swagger';
import { PageResponse } from './page-response.dto';

/**
 * Строка выдачи `GET /admin/pages` — группа перевода со всеми своими языковыми
 * версиями. Обёртка страницы описывается не здесь, а `paginatedSchema(PageGroupResponse)`
 * из `src/shared/dto/paginated-response.dto.ts` (`LEGACY-177`).
 */
export class PageGroupResponse {
  @ApiProperty({ type: String, example: 'uuid-group' })
  translationGroupId!: string;

  @ApiProperty({ type: [PageResponse] })
  pages!: PageResponse[];
}

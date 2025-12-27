import { ApiProperty } from '@nestjs/swagger';
import { PageResponse, PaginationMeta } from './page-response.dto';

export class PageGroupResponse {
  @ApiProperty({ example: 'uuid-group' })
  translationGroupId!: string;

  @ApiProperty({ type: [PageResponse] })
  pages!: PageResponse[];
}

export class PaginatedPageGroupsResponse {
  @ApiProperty({ type: [PageGroupResponse] })
  data!: PageGroupResponse[];

  @ApiProperty({ type: PaginationMeta })
  meta!: PaginationMeta;
}

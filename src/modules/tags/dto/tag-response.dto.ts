import { ApiProperty } from '@nestjs/swagger';
import { Language } from '@prisma/client';

export class TagTranslationResponse {
  @ApiProperty({ enum: Language })
  language: Language;

  @ApiProperty()
  name: string;

  @ApiProperty()
  slug: string;
}

export class TagResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  slug: string;

  @ApiProperty({ type: [TagTranslationResponse] })
  translations: TagTranslationResponse[];
}

export class PaginationMeta {
  @ApiProperty()
  page: number;

  @ApiProperty()
  limit: number;

  @ApiProperty()
  total: number;

  @ApiProperty()
  totalPages: number;
}

export class PaginatedTagsResponse {
  @ApiProperty({ type: [TagResponse] })
  data: TagResponse[];

  @ApiProperty()
  meta: PaginationMeta;
}

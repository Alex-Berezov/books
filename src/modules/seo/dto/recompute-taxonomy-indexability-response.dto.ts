import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 * Зеркалит `RecomputeResult`
 * (`src/modules/seo/indexability/taxonomy-indexability.service.ts`).
 */
export class RecomputeTaxonomyIndexabilityResponseDto {
  @ApiProperty()
  categoryTranslations!: number;

  @ApiProperty()
  tagTranslations!: number;

  @ApiProperty()
  changed!: number;

  @ApiProperty({ description: '`autoIndexable` false → true.' })
  opened!: number;

  @ApiProperty({ description: '`autoIndexable` true → false.' })
  closed!: number;
}

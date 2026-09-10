import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 * Зеркалит `RecomputeResult`
 * (`src/modules/seo/indexability/taxonomy-indexability.service.ts`).
 */
export class RecomputeTaxonomyIndexabilityResponseDto {
  @ApiProperty({ type: Number })
  categoryTranslations!: number;

  @ApiProperty({ type: Number })
  tagTranslations!: number;

  @ApiProperty({ type: Number })
  changed!: number;

  @ApiProperty({ type: Number, description: '`autoIndexable` false → true.' })
  opened!: number;

  @ApiProperty({ type: Number, description: '`autoIndexable` true → false.' })
  closed!: number;
}

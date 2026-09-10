import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Machine-readable description of the accepted report (JSON Schema 2020-12), served as-is
 * from `RightsReportSchemaDocument` (rights-intake/rights-review-schema.registry.ts).
 * `properties`/`$defs` are the raw JSON Schema subtree for the report body — their inner shape
 * is not enumerated here, it is the actual JSON Schema content of `rights-review-schema-1.0.ts`.
 */
export class RightsReportSchemaDocumentDto {
  @ApiProperty() $schema!: string;
  @ApiProperty() $id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() description!: string;
  @ApiProperty() schemaVersion!: string;
  @ApiProperty({ enum: ['object'] }) type!: 'object';
  @ApiProperty({ type: [String] }) required!: string[];
  @ApiProperty() additionalProperties!: boolean;
  @ApiProperty({ type: 'object', additionalProperties: true })
  properties!: Record<string, unknown>;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  $defs?: Record<string, unknown>;
}

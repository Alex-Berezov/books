import { ApiProperty } from '@nestjs/swagger';

export class RightsContentHashComputationDto {
  @ApiProperty({ type: String })
  versionId!: string;

  @ApiProperty({ type: String, nullable: true })
  rightsProfileId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  approvedRightsReviewId!: string | null;

  @ApiProperty({ type: String })
  hash!: string;

  @ApiProperty({ type: String })
  algorithmVersion!: string;

  @ApiProperty({ type: String })
  calculatedAt!: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
  input!: Record<string, unknown>;
}

export class RightsContentHashCheckDto {
  @ApiProperty({ type: String })
  versionId!: string;

  @ApiProperty({ type: String, nullable: true })
  baselineHash!: string | null;

  @ApiProperty({ type: String })
  currentHash!: string;

  @ApiProperty({ type: String })
  algorithmVersion!: string;

  @ApiProperty({ type: Boolean })
  matchesBaseline!: boolean;

  @ApiProperty({ type: Boolean })
  isStale!: boolean;

  @ApiProperty({ type: Boolean })
  recheckRequired!: boolean;

  @ApiProperty({ type: String, nullable: true })
  reasonCode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  reasonRu!: string | null;

  @ApiProperty({ type: String })
  checkedAt!: string;
}

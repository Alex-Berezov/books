import { ApiProperty } from '@nestjs/swagger';

export class RightsContentHashComputationDto {
  @ApiProperty()
  versionId!: string;

  @ApiProperty({ type: String, nullable: true })
  rightsProfileId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  approvedRightsReviewId!: string | null;

  @ApiProperty()
  hash!: string;

  @ApiProperty()
  algorithmVersion!: string;

  @ApiProperty()
  calculatedAt!: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
  input!: Record<string, unknown>;
}

export class RightsContentHashCheckDto {
  @ApiProperty()
  versionId!: string;

  @ApiProperty({ type: String, nullable: true })
  baselineHash!: string | null;

  @ApiProperty()
  currentHash!: string;

  @ApiProperty()
  algorithmVersion!: string;

  @ApiProperty()
  matchesBaseline!: boolean;

  @ApiProperty()
  isStale!: boolean;

  @ApiProperty()
  recheckRequired!: boolean;

  @ApiProperty({ type: String, nullable: true })
  reasonCode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  reasonRu!: string | null;

  @ApiProperty()
  checkedAt!: string;
}

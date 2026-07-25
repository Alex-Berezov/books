import { ApiProperty } from '@nestjs/swagger';

export class RightsContentHashComputationDto {
  @ApiProperty()
  versionId!: string;

  @ApiProperty({ nullable: true })
  rightsProfileId!: string | null;

  @ApiProperty({ nullable: true })
  approvedRightsReviewId!: string | null;

  @ApiProperty()
  hash!: string;

  @ApiProperty()
  algorithmVersion!: string;

  @ApiProperty()
  calculatedAt!: string;

  @ApiProperty()
  input!: Record<string, unknown>;
}

export class RightsContentHashCheckDto {
  @ApiProperty()
  versionId!: string;

  @ApiProperty({ nullable: true })
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

  @ApiProperty({ nullable: true })
  reasonCode!: string | null;

  @ApiProperty({ nullable: true })
  reasonRu!: string | null;

  @ApiProperty()
  checkedAt!: string;
}

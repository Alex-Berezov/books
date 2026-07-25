import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class PublicationGateReasonDto {
  @ApiProperty({ description: 'Unique reason code' })
  code: string;

  @ApiProperty({ enum: ['BLOCKER', 'WARNING'] })
  severity: 'BLOCKER' | 'WARNING';

  @ApiProperty({ description: 'Russian message for admin UI' })
  messageRu: string;

  @ApiProperty({ required: false })
  messageEn?: string;

  @ApiProperty({ required: false })
  details?: Record<string, unknown>;

  constructor(data: {
    code: string;
    severity: 'BLOCKER' | 'WARNING';
    messageRu: string;
    messageEn?: string;
    details?: Record<string, unknown>;
  }) {
    this.code = data.code;
    this.severity = data.severity;
    this.messageRu = data.messageRu;
    this.messageEn = data.messageEn;
    this.details = data.details;
  }
}

export class PublicationGateResultDto {
  @ApiProperty()
  versionId: string;

  @ApiProperty()
  bookId: string;

  @ApiProperty()
  canPublish: boolean;

  @ApiProperty()
  checkedAt: string;

  @ApiProperty({ nullable: true })
  rightsProfileId: string | null;

  @ApiProperty({ nullable: true })
  approvedRightsReviewId: string | null;

  @ApiProperty({ nullable: true })
  rightsStatus: string | null;

  @ApiProperty({ type: [PublicationGateReasonDto] })
  blockingReasons: PublicationGateReasonDto[];

  @ApiProperty({ type: [PublicationGateReasonDto] })
  warnings: PublicationGateReasonDto[];

  @ApiProperty({ nullable: true })
  contentHashBaseline!: string | null;

  @ApiProperty({ nullable: true })
  contentHashCurrent!: string | null;

  @ApiProperty({ nullable: true })
  contentHashMatches!: boolean | null;

  @ApiProperty()
  rightsRecheckRequired!: boolean;

  constructor(data: {
    versionId: string;
    bookId: string;
    canPublish: boolean;
    checkedAt: string;
    rightsProfileId: string | null;
    approvedRightsReviewId: string | null;
    rightsStatus: string | null;
    blockingReasons: PublicationGateReasonDto[];
    warnings: PublicationGateReasonDto[];
    contentHashBaseline?: string | null;
    contentHashCurrent?: string | null;
    contentHashMatches?: boolean | null;
    rightsRecheckRequired?: boolean;
  }) {
    this.versionId = data.versionId;
    this.bookId = data.bookId;
    this.canPublish = data.canPublish;
    this.checkedAt = data.checkedAt;
    this.rightsProfileId = data.rightsProfileId;
    this.approvedRightsReviewId = data.approvedRightsReviewId;
    this.rightsStatus = data.rightsStatus;
    this.blockingReasons = data.blockingReasons;
    this.warnings = data.warnings;
    this.contentHashBaseline = data.contentHashBaseline ?? null;
    this.contentHashCurrent = data.contentHashCurrent ?? null;
    this.contentHashMatches = data.contentHashMatches ?? null;
    this.rightsRecheckRequired = data.rightsRecheckRequired ?? false;
  }
}

export class UpdateRightsGeoBlockDto {
  @ApiProperty()
  @IsBoolean()
  configured!: boolean;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  notesRu?: string | null;
}

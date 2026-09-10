import { ApiProperty } from '@nestjs/swagger';
import { RightsIntakeStatus, RightsSourceProvider, RightsSourceTextType } from '@prisma/client';

/**
 * Полная запись `RightsIntake` в том виде, в котором её отдают `create`, `getById`, `update`,
 * `changeStatus` и `archive` — ни один из этих методов не делает `select`/`include`, поэтому
 * связи (`createdByUser`, `reviewImports`, `rightsProfiles` и т.д.) в ответе не появляются.
 */
export class RightsIntakeResponseDto {
  @ApiProperty() id!: string;

  @ApiProperty() candidateTitle!: string;
  @ApiProperty() candidateAuthor!: string;
  @ApiProperty({ type: String, nullable: true }) originalTitle!: string | null;
  @ApiProperty({ type: String, nullable: true }) originalLanguage!: string | null;
  @ApiProperty({ type: Number, nullable: true }) authorBirthYear!: number | null;
  @ApiProperty({ type: Number, nullable: true }) authorDeathYear!: number | null;

  @ApiProperty({ enum: RightsSourceProvider }) sourceProvider!: RightsSourceProvider;
  @ApiProperty({ type: String, nullable: true }) sourceExternalId!: string | null;
  @ApiProperty({ type: String, nullable: true }) sourceUrl!: string | null;
  @ApiProperty({ type: String, nullable: true }) sourceTitle!: string | null;
  @ApiProperty({ type: String, nullable: true }) sourceLanguage!: string | null;
  @ApiProperty({ enum: RightsSourceTextType }) sourceTextType!: RightsSourceTextType;

  @ApiProperty({ type: [String] }) targetLanguages!: string[];
  @ApiProperty({ type: [String] }) targetCountryCodes!: string[];
  @ApiProperty({ type: [String] }) plannedContentTypes!: string[];
  @ApiProperty({ type: [String], nullable: true }) plannedComponents!: string[] | null;

  @ApiProperty({ type: String, nullable: true }) notesRu!: string | null;
  @ApiProperty({ enum: RightsIntakeStatus }) workflowStatus!: RightsIntakeStatus;

  @ApiProperty({ type: String, nullable: true }) createdByUserId!: string | null;
  @ApiProperty({ type: String, nullable: true }) approvedReviewId!: string | null;
  @ApiProperty({ type: String, nullable: true }) createdBookId!: string | null;
  @ApiProperty({ type: String, nullable: true }) archivedAt!: string | null;

  /**
   * WP-9.1: снимок манифеста, отданного агенту. См. поле в `prisma/schema.prisma`
   * (модель `RightsIntake`) — заполняется в момент экспорта, не при создании интейка.
   */
  @ApiProperty({ type: String, nullable: true }) manifestStorageKey!: string | null;
  @ApiProperty({ type: String, nullable: true }) manifestSha256!: string | null;
  @ApiProperty({ type: String, nullable: true }) manifestVersion!: string | null;
  @ApiProperty({ type: String, nullable: true }) manifestGeneratedAt!: string | null;

  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

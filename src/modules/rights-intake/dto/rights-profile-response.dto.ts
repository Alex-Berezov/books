import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SourceEditionDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsProfileId!: string;
  @ApiProperty() provider!: string;
  @ApiProperty() externalId!: string | null;
  @ApiProperty() sourceUrl!: string | null;
  @ApiProperty() sourceTitle!: string | null;
  @ApiProperty() sourceLanguage!: string | null;
  @ApiProperty() sourceTextType!: string;
  @ApiProperty() gutenbergStatus!: string | null;
  @ApiProperty() status!: string;
  @ApiProperty() notesRu!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class EditionRightsDto {
  @ApiProperty() id!: string;
  @ApiProperty() sourceEditionId!: string;
  @ApiProperty() status!: string;
  @ApiProperty() notesRu!: string | null;
  @ApiProperty() legalBasisRu!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class RightsReviewDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsProfileId!: string;
  @ApiProperty() rightsReviewImportId!: string;
  @ApiProperty() status!: string;
  @ApiProperty() schemaVersion!: string | null;
  @ApiProperty() reviewerType!: string;
  @ApiProperty() overallStatus!: string;
  @ApiProperty() publicationGate!: string;
  @ApiProperty() confidence!: string;
  @ApiProperty() summaryRu!: string;
  @ApiProperty() conclusionRu!: string;
  @ApiProperty() reasoningRu!: string | null;
  @ApiProperty() nextReviewAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class RightsComponentDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsProfileId!: string;
  @ApiProperty() componentType!: string;
  @ApiProperty() titleRu!: string;
  @ApiProperty() status!: string;
  @ApiProperty() requiredAction!: string;
  @ApiProperty() confidence!: string;
  @ApiProperty() notesRu!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class TerritoryDecisionDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsProfileId!: string;
  @ApiProperty() countryCode!: string;
  @ApiProperty() finalStatus!: string;
  @ApiProperty() accessPolicy!: string;
  @ApiProperty() geoBlockRequired!: boolean;
  @ApiProperty() geoBlockScope!: string | null;
  @ApiProperty() reasonRu!: string;
  @ApiProperty() legalBasisRu!: string | null;
  @ApiProperty() confidence!: string;
  @ApiProperty() nextReviewAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class RightsEvidenceDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsProfileId!: string;
  @ApiProperty() evidenceType!: string;
  @ApiProperty() sourceLevel!: string;
  @ApiProperty() title!: string;
  @ApiProperty() authority!: string;
  @ApiProperty() url!: string | null;
  @ApiProperty() jurisdictionCode!: string | null;
  @ApiProperty() accessedAt!: string | null;
  @ApiProperty() relevantExcerpt!: string | null;
  @ApiProperty() summaryRu!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class RightsActionDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsProfileId!: string;
  @ApiProperty() actionType!: string;
  @ApiProperty() status!: string;
  @ApiProperty() descriptionRu!: string;
  @ApiProperty() affectedCountryCodes!: unknown;
  @ApiProperty() isBlocking!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class RightsProfileSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsIntakeId!: string;
  @ApiProperty() currentReviewImportId!: string | null;
  @ApiProperty() status!: string;
  @ApiProperty() isCurrent!: boolean;
  @ApiProperty() overallStatus!: string;
  @ApiProperty() publicationGate!: string;
  @ApiProperty() confidence!: string;
  @ApiProperty() summaryRu!: string;
  @ApiProperty() conclusionRu!: string;
  @ApiProperty() reasoningRu!: string | null;
  @ApiProperty() nextReviewAt!: string | null;
  @ApiProperty() supersededAt!: string | null;
  @ApiProperty() archivedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class RightsProfileDetailDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsIntakeId!: string;
  @ApiProperty() currentReviewImportId!: string | null;
  @ApiProperty() status!: string;
  @ApiProperty() isCurrent!: boolean;
  @ApiProperty() overallStatus!: string;
  @ApiProperty() publicationGate!: string;
  @ApiProperty() confidence!: string;
  @ApiProperty() summaryRu!: string;
  @ApiProperty() conclusionRu!: string;
  @ApiProperty() reasoningRu!: string | null;
  @ApiProperty() nextReviewAt!: string | null;

  @ApiPropertyOptional({ type: SourceEditionDto })
  sourceEdition!: SourceEditionDto | null;

  @ApiProperty({ type: [RightsReviewDto] })
  reviews!: RightsReviewDto[];

  @ApiProperty({ type: [TerritoryDecisionDto] })
  territoryDecisions!: TerritoryDecisionDto[];

  @ApiProperty({ type: [RightsComponentDto] })
  components!: RightsComponentDto[];

  @ApiProperty({ type: [RightsEvidenceDto] })
  evidence!: RightsEvidenceDto[];

  @ApiProperty({ type: [RightsActionDto] })
  actions!: RightsActionDto[];

  @ApiProperty() supersededAt!: string | null;
  @ApiProperty() archivedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class RightsProfileListDto {
  @ApiProperty({ type: [RightsProfileSummaryDto] })
  items!: RightsProfileSummaryDto[];

  @ApiProperty() total!: number;
}

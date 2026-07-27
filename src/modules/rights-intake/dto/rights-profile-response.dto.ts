import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TerritoryRegionSummaryDto } from './territory-region-summary.dto';
import { RightsReviewApprovalDto } from './rights-review-approval.dto';

export class EditionRightsDto {
  @ApiProperty() id!: string;
  @ApiProperty() sourceEditionId!: string;
  @ApiProperty() status!: string;
  @ApiProperty() notesRu!: string | null;
  @ApiProperty() legalBasisRu!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

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

  @ApiPropertyOptional({ type: EditionRightsDto })
  editionRights!: EditionRightsDto | null;
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

  @ApiPropertyOptional()
  approvedByUserId?: string | null;

  @ApiPropertyOptional()
  approvedByUser?: { id: string; name?: string; email: string } | null;

  @ApiPropertyOptional()
  approvedAt?: string | null;

  @ApiPropertyOptional()
  approvalNotesRu?: string | null;

  @ApiPropertyOptional()
  rejectedByUserId?: string | null;

  @ApiPropertyOptional()
  rejectedByUser?: { id: string; name?: string; email: string } | null;

  @ApiPropertyOptional()
  rejectedAt?: string | null;

  @ApiPropertyOptional()
  rejectionReasonRu?: string | null;

  @ApiPropertyOptional({ type: [RightsReviewApprovalDto] })
  approvals?: RightsReviewApprovalDto[];

  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class ComponentTerritoryAssessmentDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsComponentId!: string;
  @ApiProperty() countryCode!: string;
  @ApiProperty() status!: string;
  @ApiProperty() accessPolicy!: string;
  @ApiProperty() geoBlockRequired!: boolean;
  @ApiPropertyOptional({ nullable: true }) reasonRu!: string | null;
  @ApiPropertyOptional({ nullable: true }) legalBasisRu!: string | null;
  @ApiPropertyOptional({ nullable: true }) publicDomainFromYear!: number | null;
  @ApiPropertyOptional({ nullable: true }) rightsExpireAt!: string | null;
  @ApiPropertyOptional({ type: [String], nullable: true }) sourceEvidenceIds!: string[] | null;
  @ApiPropertyOptional({ nullable: true }) confidence!: string | null;
  @ApiPropertyOptional({ nullable: true }) notesRu!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class PersonSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() type!: string;
  @ApiProperty() canonicalName!: string;
  @ApiPropertyOptional({ nullable: true }) sortName?: string | null;
  @ApiPropertyOptional({ nullable: true }) slug?: string | null;
  @ApiPropertyOptional({ nullable: true }) birthYear?: number | null;
  @ApiPropertyOptional({ nullable: true }) deathYear?: number | null;
  @ApiPropertyOptional({ nullable: true }) nationalityCountryCode?: string | null;
  @ApiPropertyOptional({ nullable: true }) wikidataId?: string | null;
  @ApiPropertyOptional({ nullable: true }) viafId?: string | null;
  @ApiPropertyOptional({ nullable: true }) isni?: string | null;
  @ApiPropertyOptional({ nullable: true }) gutenbergAgentId?: string | null;
}

export class RightsProfileContributorDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsProfileId!: string;
  @ApiPropertyOptional({ nullable: true }) rightsComponentId?: string | null;
  @ApiPropertyOptional({ nullable: true }) personId?: string | null;
  @ApiProperty() role!: string;
  @ApiPropertyOptional({ nullable: true }) roleOtherRu?: string | null;
  @ApiProperty() displayName!: string;
  @ApiPropertyOptional({ nullable: true }) canonicalName?: string | null;
  @ApiPropertyOptional({ nullable: true }) creditedName?: string | null;
  @ApiPropertyOptional({ nullable: true }) birthYear?: number | null;
  @ApiPropertyOptional({ nullable: true }) deathYear?: number | null;
  @ApiPropertyOptional({ nullable: true }) nationalityCountryCode?: string | null;
  @ApiPropertyOptional({ nullable: true }) wikidataId?: string | null;
  @ApiPropertyOptional({ nullable: true }) viafId?: string | null;
  @ApiPropertyOptional({ nullable: true }) isni?: string | null;
  @ApiPropertyOptional({ nullable: true }) gutenbergAgentId?: string | null;
  @ApiPropertyOptional({ nullable: true }) publicDomainFromYear?: number | null;
  @ApiPropertyOptional({ nullable: true }) confidence?: string | null;
  @ApiPropertyOptional({ nullable: true }) notesRu?: string | null;
  @ApiPropertyOptional({ type: PersonSummaryDto, nullable: true }) person?: PersonSummaryDto | null;
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

  @ApiProperty({ type: [ComponentTerritoryAssessmentDto] })
  territoryAssessments!: ComponentTerritoryAssessmentDto[];

  @ApiPropertyOptional({ type: [RightsProfileContributorDto] })
  contributors?: RightsProfileContributorDto[];

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

  @ApiProperty({ type: [TerritoryRegionSummaryDto] })
  regionalTerritorySummary!: TerritoryRegionSummaryDto[];

  @ApiProperty({ type: [RightsComponentDto] })
  components!: RightsComponentDto[];

  @ApiProperty({ type: [RightsEvidenceDto] })
  evidence!: RightsEvidenceDto[];

  @ApiProperty({ type: [RightsActionDto] })
  actions!: RightsActionDto[];

  @ApiPropertyOptional({ type: [RightsProfileContributorDto] })
  contributors?: RightsProfileContributorDto[];

  @ApiPropertyOptional() contributorsCount?: number;
  @ApiPropertyOptional() authorsCount?: number;
  @ApiPropertyOptional() translatorsCount?: number;
  @ApiPropertyOptional() narratorsCount?: number;
  @ApiPropertyOptional() contributorsWithoutPersonCount?: number;

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

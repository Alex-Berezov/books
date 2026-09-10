import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  LicenseCoverageResultDto,
  RightsLicenseSummaryDto,
} from '../../rights-licenses/dto/rights-license-response.dto';
import { TerritoryRegionSummaryDto } from './territory-region-summary.dto';
import { RightsReviewApprovalDto } from './rights-review-approval.dto';

/** WP-7.1: права одной языковой версии издания. Одна запись на язык. */
export class EditionRightsDto {
  @ApiProperty() id!: string;
  @ApiProperty() sourceEditionId!: string;
  @ApiProperty() languageCode!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ type: String, nullable: true }) notesRu!: string | null;
  @ApiProperty({ type: String, nullable: true }) legalBasisRu!: string | null;
  @ApiProperty() translationOrigin!: string;
  @ApiProperty({ type: String, nullable: true }) translationSourceLanguage!: string | null;
  @ApiProperty() requiresGeoBlock!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class SourceEditionDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsProfileId!: string;
  @ApiProperty() provider!: string;
  @ApiProperty({ type: String, nullable: true }) externalId!: string | null;
  @ApiProperty({ type: String, nullable: true }) sourceUrl!: string | null;
  @ApiProperty({ type: String, nullable: true }) sourceTitle!: string | null;
  @ApiProperty({ type: String, nullable: true }) sourceLanguage!: string | null;
  @ApiProperty() sourceTextType!: string;
  @ApiProperty({ type: String, nullable: true }) gutenbergStatus!: string | null;
  @ApiProperty() status!: string;
  @ApiProperty({ type: String, nullable: true }) notesRu!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;

  /**
   * WP-9.1 / WP-8.3: файл исходного издания. Ключ хранилища наружу не отдаётся —
   * скачивание идёт через `GET /admin/rights/profiles/:profileId/source-file`.
   * `sourceFileSha256` показывается: по нему видно, что клиренс снят именно с этого файла.
   */
  @ApiProperty({ type: String, nullable: true }) sourceFileSha256!: string | null;
  @ApiProperty({ type: String, nullable: true }) sourceFileName!: string | null;
  @ApiProperty({ type: String, nullable: true }) sourceFileContentType!: string | null;
  @ApiProperty({ type: Number, nullable: true }) sourceFileSizeBytes!: number | null;
  @ApiProperty({ type: String, nullable: true }) sourceFileUploadedAt!: string | null;
  @ApiProperty({ description: 'Файл загружен и доступен для скачивания' })
  hasSourceFile!: boolean;

  /** WP-7.1: запись на каждый оценённый язык; пустой массив — языковой срез ещё не материализован. */
  @ApiProperty({ type: [EditionRightsDto] })
  editionRights!: EditionRightsDto[];
}

export class RightsReviewDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsProfileId!: string;
  @ApiProperty() rightsReviewImportId!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ type: String, nullable: true }) schemaVersion!: string | null;
  @ApiProperty() reviewerType!: string;
  @ApiProperty() overallStatus!: string;
  @ApiProperty() publicationGate!: string;
  @ApiProperty() confidence!: string;
  @ApiProperty() summaryRu!: string;
  @ApiProperty() conclusionRu!: string;
  @ApiProperty({ type: String, nullable: true }) reasoningRu!: string | null;
  @ApiProperty({ type: String, nullable: true }) nextReviewAt!: string | null;

  // Phase 18: review history chain
  @ApiProperty({ type: String, nullable: true }) previousReviewId!: string | null;
  @ApiProperty({ type: String, nullable: true }) chainRootReviewId!: string | null;
  @ApiProperty() revisionNumber!: number;

  @ApiProperty({ type: String, nullable: true })
  approvedByUserId!: string | null;

  @ApiProperty({
    type: 'object',
    nullable: true,
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      email: { type: 'string' },
    },
    required: ['id', 'email'],
  })
  approvedByUser!: { id: string; name?: string; email: string } | null;

  @ApiProperty({ type: String, nullable: true })
  approvedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  approvalNotesRu!: string | null;

  @ApiProperty({ type: String, nullable: true })
  rejectedByUserId!: string | null;

  @ApiProperty({
    type: 'object',
    nullable: true,
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      email: { type: 'string' },
    },
    required: ['id', 'email'],
  })
  rejectedByUser!: { id: string; name?: string; email: string } | null;

  @ApiProperty({ type: String, nullable: true })
  rejectedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  rejectionReasonRu!: string | null;

  @ApiProperty({ type: [RightsReviewApprovalDto] })
  approvals!: RightsReviewApprovalDto[];

  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class ComponentTerritoryAssessmentDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsComponentId!: string;
  @ApiProperty({ type: String, nullable: true }) licenseId!: string | null;
  @ApiProperty({ type: String, nullable: true }) licenseTitle!: string | null;
  @ApiProperty() countryCode!: string;
  @ApiProperty() status!: string;
  @ApiProperty() accessPolicy!: string;
  @ApiProperty() geoBlockRequired!: boolean;
  @ApiProperty({ type: String, nullable: true }) reasonRu!: string | null;
  @ApiProperty({ type: String, nullable: true }) legalBasisRu!: string | null;
  @ApiProperty({ type: Number, nullable: true }) publicDomainFromYear!: number | null;
  @ApiProperty({ type: String, nullable: true }) rightsExpireAt!: string | null;
  @ApiProperty({ type: [String], nullable: true }) sourceEvidenceIds!: string[] | null;
  @ApiProperty({ type: String, nullable: true }) confidence!: string | null;
  @ApiProperty({ type: String, nullable: true }) notesRu!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class PersonSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() type!: string;
  @ApiProperty() canonicalName!: string;
  @ApiProperty({ type: String, nullable: true }) sortName!: string | null;
  @ApiProperty({ type: String, nullable: true }) slug!: string | null;
  @ApiProperty({ type: Number, nullable: true }) birthYear!: number | null;
  @ApiProperty({ type: Number, nullable: true }) deathYear!: number | null;
  @ApiProperty({ type: String, nullable: true }) nationalityCountryCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) wikidataId!: string | null;
  @ApiProperty({ type: String, nullable: true }) viafId!: string | null;
  @ApiProperty({ type: String, nullable: true }) isni!: string | null;
  @ApiProperty({ type: String, nullable: true }) gutenbergAgentId!: string | null;
}

export class RightsProfileContributorDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsProfileId!: string;
  @ApiProperty({ type: String, nullable: true }) rightsComponentId!: string | null;
  @ApiProperty({ type: String, nullable: true }) personId!: string | null;
  @ApiProperty() role!: string;
  @ApiProperty({ type: String, nullable: true }) roleOtherRu!: string | null;
  @ApiProperty() displayName!: string;
  @ApiProperty({ type: String, nullable: true }) canonicalName!: string | null;
  @ApiProperty({ type: String, nullable: true }) creditedName!: string | null;
  @ApiProperty({ type: Number, nullable: true }) birthYear!: number | null;
  @ApiProperty({ type: Number, nullable: true }) deathYear!: number | null;
  @ApiProperty({ type: String, nullable: true }) nationalityCountryCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) wikidataId!: string | null;
  @ApiProperty({ type: String, nullable: true }) viafId!: string | null;
  @ApiProperty({ type: String, nullable: true }) isni!: string | null;
  @ApiProperty({ type: String, nullable: true }) gutenbergAgentId!: string | null;
  @ApiProperty({ type: String, nullable: true }) creditedLanguage!: string | null;
  @ApiProperty({ type: [String], nullable: true }) sourceEvidenceIds!: string[] | null;
  @ApiProperty({ type: Number, nullable: true }) publicDomainFromYear!: number | null;
  @ApiProperty({ type: String, nullable: true }) confidence!: string | null;
  @ApiProperty({ type: String, nullable: true }) notesRu!: string | null;
  @ApiProperty({ type: PersonSummaryDto, nullable: true }) person!: PersonSummaryDto | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class RightsComponentDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsProfileId!: string;
  @ApiProperty() componentType!: string;
  @ApiProperty() titleRu!: string;
  /** WP-7.2: `null` — компонент общий для всех языков версии. */
  @ApiProperty({ type: String, nullable: true }) languageCode!: string | null;
  @ApiProperty() status!: string;
  @ApiProperty() requiredAction!: string;
  @ApiProperty() confidence!: string;
  @ApiProperty({ type: String, nullable: true }) notesRu!: string | null;

  @ApiProperty({ type: [ComponentTerritoryAssessmentDto] })
  territoryAssessments!: ComponentTerritoryAssessmentDto[];

  @ApiProperty({ type: [RightsProfileContributorDto] })
  contributors!: RightsProfileContributorDto[];

  @ApiProperty({ type: [RightsLicenseSummaryDto] })
  licenses!: RightsLicenseSummaryDto[];

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
  @ApiProperty({ type: String, nullable: true }) geoBlockScope!: string | null;
  @ApiProperty() reasonRu!: string;
  @ApiProperty({ type: String, nullable: true }) legalBasisRu!: string | null;
  @ApiProperty() confidence!: string;
  @ApiProperty({ type: String, nullable: true }) nextReviewAt!: string | null;
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
  @ApiProperty({ type: String, nullable: true }) url!: string | null;
  @ApiProperty({ type: String, nullable: true }) jurisdictionCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) accessedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) relevantExcerpt!: string | null;
  @ApiProperty() summaryRu!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;

  /**
   * WP-9.3 (R3-08): архивная копия. Ключ хранилища наружу не отдаётся — скачивание идёт
   * через `GET /admin/rights/evidence/:evidenceId/archive-copy`.
   */
  @ApiProperty({ description: 'Архивная копия документа загружена' })
  isArchivedCopy!: boolean;
  @ApiProperty({ type: String, nullable: true }) fileSha256!: string | null;
  @ApiProperty({ type: String, nullable: true }) fileName!: string | null;
  @ApiProperty({ type: String, nullable: true }) contentType!: string | null;
  @ApiProperty({ type: Number, nullable: true }) sizeBytes!: number | null;
  @ApiProperty({ type: String, nullable: true }) archivedAt!: string | null;

  /** WP-9.3: доказательство не удаляется, а помечается заменённым другим (ADR-009). */
  @ApiProperty() isCurrent!: boolean;
  @ApiProperty({ type: String, nullable: true }) supersededById!: string | null;
}

export class RightsActionDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsProfileId!: string;
  @ApiProperty() actionType!: string;
  @ApiProperty() status!: string;
  @ApiProperty() descriptionRu!: string;
  @ApiProperty({
    type: 'array',
    items: { type: 'string' },
    description: 'Коды стран, которых касается действие (Json в базе)',
  })
  affectedCountryCodes!: unknown;
  @ApiProperty() isBlocking!: boolean;

  // WP-5.1: жизненный цикл действия — кто взял, к какому сроку, кто и когда закрыл.
  @ApiProperty({ type: String, nullable: true }) assignedToUserId!: string | null;
  @ApiProperty({ type: String, nullable: true }) dueAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) completedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) completedByUserId!: string | null;
  @ApiProperty({ type: String, nullable: true }) completionNotesRu!: string | null;

  /** Закрыто ли действие: `COMPLETED` или `WAIVED`. `CANCELLED` закрытым не считается. */
  @ApiProperty() isResolved!: boolean;

  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class RightsProfileSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsIntakeId!: string;
  @ApiProperty({ type: String, nullable: true }) currentReviewImportId!: string | null;
  @ApiProperty() status!: string;
  @ApiProperty() isCurrent!: boolean;
  @ApiProperty() overallStatus!: string;
  @ApiProperty() publicationGate!: string;
  @ApiProperty() confidence!: string;
  @ApiProperty() summaryRu!: string;
  @ApiProperty() conclusionRu!: string;
  @ApiProperty({ type: String, nullable: true }) reasoningRu!: string | null;
  @ApiProperty({ type: String, nullable: true }) nextReviewAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) supersededAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) archivedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class RightsProfileDetailDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsIntakeId!: string;
  @ApiProperty({ type: String, nullable: true }) currentReviewImportId!: string | null;
  @ApiProperty() status!: string;
  @ApiProperty() isCurrent!: boolean;
  @ApiProperty() overallStatus!: string;
  @ApiProperty() publicationGate!: string;
  @ApiProperty() confidence!: string;
  @ApiProperty() summaryRu!: string;
  @ApiProperty() conclusionRu!: string;
  @ApiProperty({ type: String, nullable: true }) reasoningRu!: string | null;
  @ApiProperty({ type: String, nullable: true }) nextReviewAt!: string | null;

  @ApiProperty({ type: SourceEditionDto, nullable: true })
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

  @ApiProperty({ type: [RightsProfileContributorDto] })
  contributors!: RightsProfileContributorDto[];

  @ApiProperty() contributorsCount!: number;
  @ApiProperty() authorsCount!: number;
  @ApiProperty() translatorsCount!: number;
  @ApiProperty() narratorsCount!: number;
  @ApiProperty() contributorsWithoutPersonCount!: number;

  // Phase 15: licenses reachable from this profile and their coverage of license-gated markets
  @ApiProperty({ type: [RightsLicenseSummaryDto] })
  licenses!: RightsLicenseSummaryDto[];

  @ApiProperty({ type: LicenseCoverageResultDto, nullable: true })
  licenseCoverage!: LicenseCoverageResultDto | null;

  @ApiProperty() licensesCount!: number;
  @ApiProperty() activeLicensesCount!: number;
  @ApiProperty() expiredLicensesCount!: number;
  @ApiProperty() revokedLicensesCount!: number;
  @ApiProperty() expiringSoonLicensesCount!: number;
  @ApiProperty() licenseRequiredCountriesCount!: number;
  @ApiProperty() licenseCoveredCountriesCount!: number;
  @ApiProperty() licenseUncoveredCountriesCount!: number;

  // Phase 19: снимок оценки риска и юридического утверждения. Читается из уже загруженной
  // записи профиля — дополнительных запросов маппинг не делает.
  @ApiPropertyOptional() riskLevel?: string;
  @ApiPropertyOptional({ type: [Object] }) riskFactors?: Record<string, unknown>[];
  @ApiProperty({ type: String, nullable: true }) riskAssessedAt!: string | null;
  @ApiPropertyOptional() lawyerReviewRequired?: boolean;
  @ApiPropertyOptional() lawyerReviewBlocking?: boolean;
  @ApiProperty({ type: String, nullable: true }) currentLawyerReviewId!: string | null;
  @ApiProperty({ type: String, nullable: true }) lawyerApprovedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) lawyerApprovedLawyerName!: string | null;
  @ApiProperty({ type: String, nullable: true }) lawyerOpinionValidUntil!: string | null;

  @ApiProperty({ type: String, nullable: true }) supersededAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) archivedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class RightsProfileListDto {
  @ApiProperty({ type: [RightsProfileSummaryDto] })
  items!: RightsProfileSummaryDto[];

  @ApiProperty() total!: number;
}

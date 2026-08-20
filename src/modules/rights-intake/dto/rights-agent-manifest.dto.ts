import { ApiProperty } from '@nestjs/swagger';
import { RightsIntakeReadinessItemDto } from './rights-intake-readiness.dto';

class ManifestIntakeDto {
  @ApiProperty() id!: string;
  @ApiProperty() workflowStatus!: string;
  @ApiProperty() candidateTitle!: string;
  @ApiProperty() candidateAuthor!: string;
  @ApiProperty() originalTitle!: string | null;
  @ApiProperty() originalLanguage!: string | null;
  @ApiProperty() authorBirthYear!: number | null;
  @ApiProperty() authorDeathYear!: number | null;
  @ApiProperty() notesRu!: string | null;
}

class ManifestSourceDto {
  @ApiProperty() provider!: string;
  /**
   * WP-M.1: имя площадки, выведенное из ссылки. `provider` — значение enum'а из трёх
   * вариантов, и для всего, кроме Gutenberg, это `OTHER`; агент по нему не отличит Викитеку
   * от сайта издательства, поэтому площадка называется здесь.
   */
  @ApiProperty({ example: 'Wikisource (ru)', nullable: true })
  providerHint!: string | null;
  @ApiProperty() externalId!: string | null;
  @ApiProperty() url!: string | null;
  @ApiProperty() title!: string | null;
  @ApiProperty() language!: string | null;
  @ApiProperty() textType!: string;
  /**
   * WP-F.1: `true` — провайдер и внешний ID выведены приложением из ссылки. Это догадка
   * Bibliaris, а не факт, установленный человеком, и агент обязан её проверить.
   */
  @ApiProperty({ example: false }) derivedFromUrl!: boolean;
}

class ManifestReadinessDto {
  @ApiProperty({ type: [RightsIntakeReadinessItemDto] })
  missing!: RightsIntakeReadinessItemDto[];
  @ApiProperty({ type: [RightsIntakeReadinessItemDto] })
  warnings!: RightsIntakeReadinessItemDto[];
}

class ManifestPublicationPlanDto {
  @ApiProperty({ type: [String] }) targetLanguages!: string[];
  @ApiProperty({ type: [String] }) targetCountryCodes!: string[];
  @ApiProperty({ type: [String] }) plannedContentTypes!: string[];
  @ApiProperty({ type: [String] }) plannedComponents!: string[];
}

class ManifestAgentTaskDto {
  @ApiProperty() objective!: string;
  @ApiProperty({ type: [String] }) requiredChecks!: string[];
  @ApiProperty({ type: [String] }) requiredOutputs!: string[];
  @ApiProperty({ type: [String] }) importantRules!: string[];
}

class ManifestSubmissionDto {
  @ApiProperty({ example: 'https://api.bibliaris.com/api/rights/agent/submissions' })
  endpoint!: string;
  @ApiProperty({ example: 'POST' }) method!: string;
  @ApiProperty({ example: 'X-Bibliaris-Agent-Token' }) authHeader!: string;
  @ApiProperty() note!: string;
}

class ManifestExpectedResultSchemaDto {
  @ApiProperty() schemaVersion!: string;
  @ApiProperty({ example: 'json' }) format!: string;
  @ApiProperty({ example: 'https://api.bibliaris.com/api/rights/agent/report-schema/1.0' })
  schemaUrl!: string;
  @ApiProperty({ type: [String] }) requiredTopLevelFields!: string[];
  @ApiProperty({ type: ManifestSubmissionDto }) submission!: ManifestSubmissionDto;
  @ApiProperty({ type: [String] }) notes!: string[];
}

class ManifestGeneratedByDto {
  @ApiProperty() product!: string;
  @ApiProperty() module!: string;
}

export class RightsAgentManifestDto {
  @ApiProperty() manifestVersion!: string;
  @ApiProperty({ example: 'BIBLIARIS_RIGHTS_CLEARANCE_INPUT' }) manifestType!: string;
  @ApiProperty() generatedAt!: string;
  @ApiProperty({ type: ManifestGeneratedByDto }) generatedBy!: ManifestGeneratedByDto;
  @ApiProperty({ type: ManifestIntakeDto }) intake!: ManifestIntakeDto;
  @ApiProperty({ type: ManifestSourceDto }) source!: ManifestSourceDto;
  @ApiProperty({ type: ManifestPublicationPlanDto }) publicationPlan!: ManifestPublicationPlanDto;
  @ApiProperty({ type: ManifestAgentTaskDto }) agentTask!: ManifestAgentTaskDto;
  @ApiProperty({ type: ManifestExpectedResultSchemaDto })
  expectedResultSchema!: ManifestExpectedResultSchemaDto;
  /** WP-F.5: пробелы интейка. Справочные — выдачу манифеста они не останавливают. */
  @ApiProperty({ type: ManifestReadinessDto }) readiness!: ManifestReadinessDto;
}

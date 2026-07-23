import { ApiProperty } from '@nestjs/swagger';

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
  @ApiProperty() externalId!: string | null;
  @ApiProperty() url!: string | null;
  @ApiProperty() title!: string | null;
  @ApiProperty() language!: string | null;
  @ApiProperty() textType!: string;
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

class ManifestExpectedResultSchemaDto {
  @ApiProperty() schemaVersion!: string;
  @ApiProperty({ example: 'json' }) format!: string;
  @ApiProperty({ type: [String] }) requiredTopLevelFields!: string[];
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
}

import { ApiProperty } from '@nestjs/swagger';
import { RightsConfidence } from '@prisma/client';
import { ContributorRole } from '../../persons/person-interface';

/**
 * Связь участника с rights profile или его компонентом.
 * Физически хранится в таблице RightsProfileContributor (см. фазу 14).
 * Строка отдаётся целиком (contributors.service.ts: create/delete без `select`),
 * поэтому здесь все поля модели, а не только те, что приходят в DTO создания связи.
 */
export class ContributorLinkResponseDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  rightsProfileId!: string;

  @ApiProperty({ type: String, nullable: true })
  rightsComponentId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  personId!: string | null;

  @ApiProperty({ enum: ContributorRole })
  role!: ContributorRole;

  @ApiProperty({ type: String, nullable: true })
  roleOtherRu!: string | null;

  @ApiProperty({ type: String })
  displayName!: string;

  @ApiProperty({ type: String, nullable: true })
  canonicalName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  creditedName!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  birthYear!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  deathYear!: number | null;

  @ApiProperty({ type: String, nullable: true, description: '2-letter country code' })
  nationalityCountryCode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  wikidataId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  viafId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  isni!: string | null;

  @ApiProperty({ type: String, nullable: true })
  gutenbergAgentId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  creditedLanguage!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  publicDomainFromYear!: number | null;

  @ApiProperty({
    type: 'array',
    items: { type: 'string' },
    nullable: true,
    description: 'Идентификаторы доказательств, из которых взята роль (Json в базе)',
  })
  sourceEvidenceIds!: unknown;

  @ApiProperty({ enum: RightsConfidence, nullable: true })
  confidence!: RightsConfidence | null;

  @ApiProperty({ type: String, nullable: true })
  notesRu!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

export class ContributorResponseDto {
  @ApiProperty({ type: String, description: 'Person ID — участники хранятся в справочнике Person' })
  id!: string;

  @ApiProperty({ type: String })
  displayName!: string;

  @ApiProperty({ type: String, nullable: true })
  sortName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  birthDate!: string | null;

  @ApiProperty({ type: String, nullable: true })
  deathDate!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  birthYear!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  deathYear!: number | null;

  @ApiProperty({ type: String, nullable: true, description: '2-letter country code' })
  nationalityCountry!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  publicDomainFromYear!: number | null;

  @ApiProperty({ type: String, nullable: true })
  wikidataId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  viafId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  isni!: string | null;

  @ApiProperty({ type: String, nullable: true })
  gutenbergAgentId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  notesRu!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

export class ContributorListResponseDto {
  @ApiProperty({ type: [ContributorResponseDto] })
  items!: ContributorResponseDto[];

  @ApiProperty({ type: Number })
  total!: number;

  @ApiProperty({ type: Number })
  page!: number;

  @ApiProperty({ type: Number })
  limit!: number;
}

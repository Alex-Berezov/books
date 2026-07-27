import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContributorRole } from '../../persons/person-interface';

/**
 * Связь участника с rights profile или его компонентом.
 * Физически хранится в таблице RightsProfileContributor (см. фазу 14).
 */
export class ContributorLinkResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  rightsProfileId!: string;

  @ApiPropertyOptional({ nullable: true })
  rightsComponentId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  personId?: string | null;

  @ApiProperty({ enum: ContributorRole })
  role!: ContributorRole;

  @ApiProperty()
  displayName!: string;

  @ApiPropertyOptional({ nullable: true })
  creditedName?: string | null;

  @ApiPropertyOptional({ nullable: true })
  notesRu?: string | null;

  @ApiProperty()
  createdAt!: Date;
}

export class ContributorResponseDto {
  @ApiProperty({ description: 'Person ID — участники хранятся в справочнике Person' })
  id!: string;

  @ApiProperty()
  displayName!: string;

  @ApiPropertyOptional({ nullable: true })
  sortName?: string | null;

  @ApiPropertyOptional({ nullable: true })
  birthDate?: string | null;

  @ApiPropertyOptional({ nullable: true })
  deathDate?: string | null;

  @ApiPropertyOptional({ nullable: true })
  birthYear?: number | null;

  @ApiPropertyOptional({ nullable: true })
  deathYear?: number | null;

  @ApiPropertyOptional({ nullable: true, description: '2-letter country code' })
  nationalityCountry?: string | null;

  @ApiPropertyOptional({ nullable: true })
  publicDomainFromYear?: number | null;

  @ApiPropertyOptional({ nullable: true })
  wikidataId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  viafId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  isni?: string | null;

  @ApiPropertyOptional({ nullable: true })
  gutenbergAgentId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  notesRu?: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class ContributorListResponseDto {
  @ApiProperty({ type: [ContributorResponseDto] })
  items!: ContributorResponseDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContributorIdentityConfidenceDto, ContributorRoleDto } from './create-contributor.dto';

export class SourceEditionContributorResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  sourceEditionId!: string;

  @ApiProperty()
  contributorId!: string;

  @ApiProperty({ enum: ContributorRoleDto })
  role!: ContributorRoleDto;

  @ApiPropertyOptional()
  creditedName?: string;

  @ApiPropertyOptional()
  evidenceId?: string;

  @ApiPropertyOptional()
  notesRu?: string;

  @ApiProperty()
  createdAt!: Date;
}

export class RightsComponentContributorResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  rightsComponentId!: string;

  @ApiProperty()
  contributorId!: string;

  @ApiProperty({ enum: ContributorRoleDto })
  role!: ContributorRoleDto;

  @ApiPropertyOptional()
  creditedName?: string;

  @ApiPropertyOptional()
  notesRu?: string;

  @ApiProperty()
  createdAt!: Date;
}

export class ContributorResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  displayName!: string;

  @ApiPropertyOptional()
  originalName?: string;

  @ApiPropertyOptional()
  birthDate?: Date;

  @ApiPropertyOptional()
  deathDate?: Date;

  @ApiPropertyOptional()
  birthYear?: number;

  @ApiPropertyOptional()
  deathYear?: number;

  @ApiPropertyOptional()
  nationalityCountry?: string;

  @ApiPropertyOptional()
  pseudonym?: string;

  @ApiPropertyOptional()
  viafId?: string;

  @ApiPropertyOptional()
  locAuthorityId?: string;

  @ApiPropertyOptional()
  otherAuthorityIds?: Record<string, unknown>;

  @ApiProperty({ enum: ContributorIdentityConfidenceDto })
  identityConfidence!: ContributorIdentityConfidenceDto;

  @ApiPropertyOptional()
  notesRu?: string;

  @ApiPropertyOptional()
  authorId?: string;

  @ApiPropertyOptional({ type: [SourceEditionContributorResponseDto] })
  sourceEditionContributors?: SourceEditionContributorResponseDto[];

  @ApiPropertyOptional({ type: [RightsComponentContributorResponseDto] })
  rightsComponentContributors?: RightsComponentContributorResponseDto[];

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

  @ApiProperty()
  totalPages!: number;
}

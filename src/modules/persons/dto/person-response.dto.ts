import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import { PersonType } from '../person-interface';

export class PersonTranslationResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  personId!: string;

  @ApiProperty({ enum: Language })
  language!: Language;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  displayName!: string;

  @ApiPropertyOptional()
  biography?: string | null;

  @ApiPropertyOptional()
  shortDescription?: string | null;

  @ApiPropertyOptional()
  wikidataUrl?: string | null;

  @ApiPropertyOptional()
  wikipediaUrl?: string | null;

  @ApiPropertyOptional()
  photoUrl?: string | null;
}

export class PersonListItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: PersonType })
  type!: PersonType;

  @ApiProperty()
  canonicalName!: string;

  @ApiPropertyOptional()
  sortName?: string | null;

  @ApiPropertyOptional()
  slug?: string | null;

  @ApiPropertyOptional()
  birthDate?: string | null;

  @ApiPropertyOptional()
  deathDate?: string | null;

  @ApiPropertyOptional()
  birthYear?: number | null;

  @ApiPropertyOptional()
  deathYear?: number | null;

  @ApiPropertyOptional()
  nationalityCountryCode?: string | null;

  @ApiPropertyOptional()
  publicDomainFromYear?: number | null;

  @ApiPropertyOptional()
  wikidataId?: string | null;

  @ApiPropertyOptional()
  viafId?: string | null;

  @ApiPropertyOptional()
  isni?: string | null;

  @ApiPropertyOptional()
  gutenbergAgentId?: string | null;

  @ApiPropertyOptional()
  notesRu?: string | null;
}

export class PersonDetailDto extends PersonListItemDto {
  @ApiProperty({ type: [PersonTranslationResponseDto] })
  translations!: PersonTranslationResponseDto[];
}

export class PersonListResponseDto {
  @ApiProperty({ type: [PersonListItemDto] })
  items!: PersonListItemDto[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  offset!: number;
}

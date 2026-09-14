import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language } from '@prisma/client';
import { PersonType } from '../person-interface';

export class PersonTranslationResponseDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  personId!: string;

  @ApiProperty({ enum: Language })
  language!: Language;

  @ApiProperty({ type: String })
  slug!: string;

  @ApiProperty({ type: String })
  displayName!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  biography?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  shortDescription?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  wikidataUrl?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  wikipediaUrl?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  photoUrl?: string | null;

  // Перевод приходит связью без `select` (`persons.service.ts`: `include: { translations: true }`),
  // то есть строкой целиком — служебные поля в ответе есть. До 14.09.2026 схема их не называла,
  // и сторож схемы ответа этого не видел: тип возврата сервиса был `Record<string, unknown>`
  // (`LEGACY-016`).
  @ApiPropertyOptional({ type: Number, nullable: true })
  seoId?: number | null;

  @ApiProperty({ type: Date })
  createdAt!: Date;

  @ApiProperty({ type: Date })
  updatedAt!: Date;
}

export class PersonListItemDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ enum: PersonType })
  type!: PersonType;

  @ApiProperty({ type: String })
  canonicalName!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  sortName?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  slug?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  birthDate?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  deathDate?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  birthYear?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  deathYear?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  nationalityCountryCode?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  publicDomainFromYear?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  wikidataId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  viafId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  isni?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  gutenbergAgentId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  notesRu?: string | null;

  // Персона приходит связью без `select` (book-version.service.ts, persons.service.ts),
  // то есть строкой целиком - служебные поля в ответе есть.
  @ApiProperty({ type: Date })
  createdAt!: Date;

  @ApiProperty({ type: Date })
  updatedAt!: Date;
}

export class PersonDetailDto extends PersonListItemDto {
  @ApiProperty({ type: [PersonTranslationResponseDto] })
  translations!: PersonTranslationResponseDto[];
}

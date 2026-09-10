import { ApiProperty } from '@nestjs/swagger';
import { RightsConfidence } from '@prisma/client';
import { PersonListItemDto } from '../../persons/dto/person-response.dto';
import { ContributorRole } from '../../persons/person-interface';

export class BookVersionContributorResponseDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  bookVersionId!: string;

  @ApiProperty({ type: String })
  personId!: string;

  @ApiProperty({ enum: ContributorRole })
  role!: ContributorRole;

  @ApiProperty({ type: String, nullable: true })
  roleOtherRu!: string | null;

  @ApiProperty({ type: Number })
  displayOrder!: number;

  @ApiProperty({ type: Boolean })
  isPrimary!: boolean;

  @ApiProperty({ type: String, nullable: true })
  creditedName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  creditedLanguage!: string | null;

  @ApiProperty({ type: String, nullable: true })
  contributionNoteRu!: string | null;

  @ApiProperty({ enum: RightsConfidence, nullable: true })
  confidence!: RightsConfidence | null;

  // Строка отдаётся целиком (book-version.service.ts: findMany/create без `select`),
  // поэтому здесь и служебные поля Prisma, и `sourceEvidenceIds`.
  @ApiProperty({
    type: 'array',
    items: { type: 'string' },
    nullable: true,
    description: 'Идентификаторы доказательств, из которых взята роль (Json в базе)',
  })
  sourceEvidenceIds!: unknown;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: PersonListItemDto })
  person!: PersonListItemDto;
}

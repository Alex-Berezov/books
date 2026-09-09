import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RightsConfidence } from '@prisma/client';
import { PersonListItemDto } from '../../persons/dto/person-response.dto';
import { ContributorRole } from '../../persons/person-interface';

export class BookVersionContributorResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  bookVersionId!: string;

  @ApiProperty()
  personId!: string;

  @ApiProperty({ enum: ContributorRole })
  role!: ContributorRole;

  @ApiPropertyOptional()
  roleOtherRu?: string | null;

  @ApiProperty()
  displayOrder!: number;

  @ApiProperty()
  isPrimary!: boolean;

  @ApiPropertyOptional()
  creditedName?: string | null;

  @ApiPropertyOptional()
  creditedLanguage?: string | null;

  @ApiPropertyOptional()
  contributionNoteRu?: string | null;

  @ApiPropertyOptional({ enum: RightsConfidence })
  confidence?: RightsConfidence | null;

  // Строка отдаётся целиком (book-version.service.ts: findMany/create без `select`),
  // поэтому здесь и служебные поля Prisma, и `sourceEvidenceIds`.
  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'string' },
    nullable: true,
    description: 'Идентификаторы доказательств, из которых взята роль (Json в базе)',
  })
  sourceEvidenceIds?: unknown;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  @ApiPropertyOptional({ type: PersonListItemDto })
  person?: PersonListItemDto;
}

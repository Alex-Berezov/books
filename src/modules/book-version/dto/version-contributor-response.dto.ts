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

  @ApiPropertyOptional({ type: PersonListItemDto })
  person?: PersonListItemDto;
}

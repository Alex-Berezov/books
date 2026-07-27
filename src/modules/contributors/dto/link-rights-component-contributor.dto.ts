import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { ContributorRole } from '../../persons/person-interface';

export class LinkRightsComponentContributorDto {
  @ApiProperty({ description: 'ID of the person to link as contributor' })
  @IsUUID()
  contributorId!: string;

  @ApiProperty({
    enum: ContributorRole,
    description: 'Role of the contributor for this rights component',
  })
  @IsEnum(ContributorRole)
  role!: ContributorRole;

  @ApiPropertyOptional({ description: 'Credited name' })
  @IsOptional()
  @IsString()
  creditedName?: string;

  @ApiPropertyOptional({ description: 'Notes in Russian' })
  @IsOptional()
  @IsString()
  notesRu?: string;
}

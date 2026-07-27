import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { ContributorRole } from '../../persons/person-interface';

export class LinkSourceEditionContributorDto {
  @ApiProperty({ description: 'ID of the person to link as contributor' })
  @IsUUID()
  contributorId!: string;

  @ApiProperty({
    enum: ContributorRole,
    description: 'Role of the contributor in this source edition',
  })
  @IsEnum(ContributorRole)
  role!: ContributorRole;

  @ApiPropertyOptional({ description: 'Credited name as printed in source edition' })
  @IsOptional()
  @IsString()
  creditedName?: string;

  @ApiPropertyOptional({ description: 'Notes in Russian' })
  @IsOptional()
  @IsString()
  notesRu?: string;
}

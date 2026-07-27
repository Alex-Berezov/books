import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { ContributorRoleDto } from './create-contributor.dto';

export class LinkSourceEditionContributorDto {
  @ApiProperty({ description: 'ID of the contributor to link' })
  @IsUUID()
  contributorId!: string;

  @ApiProperty({
    enum: ContributorRoleDto,
    description: 'Role of the contributor in this source edition',
  })
  @IsEnum(ContributorRoleDto)
  role!: ContributorRoleDto;

  @ApiPropertyOptional({ description: 'Credited name as printed in source edition' })
  @IsOptional()
  @IsString()
  creditedName?: string;

  @ApiPropertyOptional({ description: 'Optional linked RightsEvidence ID' })
  @IsOptional()
  @IsUUID()
  evidenceId?: string;

  @ApiPropertyOptional({ description: 'Notes in Russian' })
  @IsOptional()
  @IsString()
  notesRu?: string;
}

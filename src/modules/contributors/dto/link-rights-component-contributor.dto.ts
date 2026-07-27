import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { ContributorRoleDto } from './create-contributor.dto';

export class LinkRightsComponentContributorDto {
  @ApiProperty({ description: 'ID of the contributor to link' })
  @IsUUID()
  contributorId!: string;

  @ApiProperty({
    enum: ContributorRoleDto,
    description: 'Role of the contributor for this rights component',
  })
  @IsEnum(ContributorRoleDto)
  role!: ContributorRoleDto;

  @ApiPropertyOptional({ description: 'Credited name' })
  @IsOptional()
  @IsString()
  creditedName?: string;

  @ApiPropertyOptional({ description: 'Notes in Russian' })
  @IsOptional()
  @IsString()
  notesRu?: string;
}

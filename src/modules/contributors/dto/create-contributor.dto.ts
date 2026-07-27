import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class CreateContributorDto {
  @ApiProperty({ description: 'Display name of contributor', example: 'Alexander Pope' })
  @IsString()
  displayName!: string;

  @ApiPropertyOptional({
    description: 'Date of birth as recorded in sources',
    example: '1688-05-21',
  })
  @IsOptional()
  @IsString()
  birthDate?: string;

  @ApiPropertyOptional({
    description: 'Date of death as recorded in sources',
    example: '1744-05-30',
  })
  @IsOptional()
  @IsString()
  deathDate?: string;

  @ApiPropertyOptional({ description: 'Birth year', example: 1688 })
  @IsOptional()
  @IsInt()
  @Min(-3000)
  @Max(2100)
  birthYear?: number;

  @ApiPropertyOptional({ description: 'Death year', example: 1744 })
  @IsOptional()
  @IsInt()
  @Min(-3000)
  @Max(2100)
  deathYear?: number;

  @ApiPropertyOptional({ description: '2-letter country code (nationality)', example: 'GB' })
  @IsOptional()
  @IsString()
  nationalityCountry?: string;

  @ApiPropertyOptional({ description: 'Year the works enter public domain', example: 1815 })
  @IsOptional()
  @IsInt()
  @Min(-3000)
  @Max(2200)
  publicDomainFromYear?: number;

  @ApiPropertyOptional({ description: 'Wikidata ID', example: 'Q7245' })
  @IsOptional()
  @IsString()
  wikidataId?: string;

  @ApiPropertyOptional({ description: 'VIAF ID', example: '24606633' })
  @IsOptional()
  @IsString()
  viafId?: string;

  @ApiPropertyOptional({ description: 'ISNI', example: '0000000121174572' })
  @IsOptional()
  @IsString()
  isni?: string;

  @ApiPropertyOptional({ description: 'Project Gutenberg agent ID', example: '53' })
  @IsOptional()
  @IsString()
  gutenbergAgentId?: string;

  @ApiPropertyOptional({ description: 'Notes in Russian' })
  @IsOptional()
  @IsString()
  notesRu?: string;

  @ApiPropertyOptional({
    description: 'Optional legacy catalog Author ID to bridge with this person',
  })
  @IsOptional()
  @IsUUID()
  authorId?: string;
}

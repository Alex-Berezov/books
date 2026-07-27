import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PersonType } from '../person-interface';

export class CreatePersonDto {
  @ApiProperty({ example: 'NATURAL_PERSON', enum: PersonType })
  @IsEnum(PersonType)
  @IsOptional()
  type?: PersonType;

  @ApiProperty({ example: 'Mark Twain' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  canonicalName!: string;

  @ApiPropertyOptional({ example: 'Twain, Mark' })
  @IsString()
  @IsOptional()
  sortName?: string;

  @ApiPropertyOptional({ example: 'mark-twain' })
  @IsString()
  @IsOptional()
  slug?: string;

  @ApiPropertyOptional({ example: '1835-11-30' })
  @IsString()
  @IsOptional()
  birthDate?: string;

  @ApiPropertyOptional({ example: '1910-04-21' })
  @IsString()
  @IsOptional()
  deathDate?: string;

  @ApiPropertyOptional({ example: 1835 })
  @IsInt()
  @IsOptional()
  birthYear?: number;

  @ApiPropertyOptional({ example: 1910 })
  @IsInt()
  @IsOptional()
  deathYear?: number;

  @ApiPropertyOptional({ example: 'US' })
  @IsString()
  @IsOptional()
  nationalityCountryCode?: string;

  @ApiPropertyOptional({ example: 1981 })
  @IsInt()
  @IsOptional()
  publicDomainFromYear?: number;

  @ApiPropertyOptional({ example: 'Q7245' })
  @IsString()
  @IsOptional()
  wikidataId?: string;

  @ApiPropertyOptional({ example: '505050' })
  @IsString()
  @IsOptional()
  viafId?: string;

  @ApiPropertyOptional({ example: '0000-0001-2345-6789' })
  @IsString()
  @IsOptional()
  isni?: string;

  @ApiPropertyOptional({ example: '53' })
  @IsString()
  @IsOptional()
  gutenbergAgentId?: string;

  @ApiPropertyOptional({ example: 'Американский писатель, журналист и общественный деятель.' })
  @IsString()
  @IsOptional()
  notesRu?: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateIf,
} from 'class-validator';
import { RightsConfidence } from '@prisma/client';
import { ContributorRole } from '../../persons/person-interface';

export class CreateBookVersionContributorDto {
  @ApiProperty({ description: 'Target Person ID' })
  @IsString()
  @IsNotEmpty()
  personId!: string;

  @ApiProperty({ enum: ContributorRole })
  @IsEnum(ContributorRole)
  role!: ContributorRole;

  @ApiPropertyOptional({ description: 'Role name in Russian if role=OTHER' })
  @ValidateIf((o: CreateBookVersionContributorDto) => o.role === ContributorRole.OTHER)
  @IsString()
  @IsNotEmpty({ message: 'roleOtherRu is required when role is OTHER' })
  roleOtherRu?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsInt()
  @IsOptional()
  displayOrder?: number = 0;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  isPrimary?: boolean = false;

  @ApiPropertyOptional({ description: 'Credited name as shown in the book edition' })
  @IsString()
  @IsOptional()
  creditedName?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  creditedLanguage?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  contributionNoteRu?: string;

  @ApiPropertyOptional({ enum: RightsConfidence })
  @IsEnum(RightsConfidence)
  @IsOptional()
  confidence?: RightsConfidence;
}

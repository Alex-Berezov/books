import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { LAWYER_OPINION_MAX_BODY_LENGTH } from '../rights-lawyer.constants';
import { RightsLegalOpinionKind } from '../rights-lawyer-interface';

export class CreateLegalOpinionDto {
  @ApiPropertyOptional({ enum: RightsLegalOpinionKind })
  @IsOptional()
  @IsEnum(RightsLegalOpinionKind)
  kind?: RightsLegalOpinionKind;

  @ApiProperty({ minLength: 3, maxLength: 300 })
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  titleRu!: string;

  @ApiProperty({ minLength: 10, maxLength: LAWYER_OPINION_MAX_BODY_LENGTH })
  @IsString()
  @MinLength(10)
  @MaxLength(LAWYER_OPINION_MAX_BODY_LENGTH)
  bodyRu!: string;

  @ApiPropertyOptional({ description: 'Если не задан — берётся назначенный юрист проверки' })
  @IsOptional()
  @IsUUID()
  lawyerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  documentUrl?: string;

  @ApiPropertyOptional({ description: 'sha256 в нижнем регистре' })
  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/)
  documentSha256?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  fileName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  mimeType?: string;

  @ApiPropertyOptional({ description: 'ISO 8601' })
  @IsOptional()
  @IsISO8601()
  issuedAt?: string;

  @ApiPropertyOptional({ type: [String], description: 'ISO 3166-1 alpha-2' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(250)
  @IsString({ each: true })
  jurisdictionCodes?: string[];
}

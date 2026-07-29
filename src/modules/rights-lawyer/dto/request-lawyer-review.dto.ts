import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { RightsLawyerReviewTrigger, RightsRiskLevel } from '../rights-lawyer-interface';

const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true' || value === '1' || value === true) return true;
  if (value === 'false' || value === '0' || value === false) return false;
  return value;
};

export class RequestLawyerReviewDto {
  @ApiPropertyOptional({ description: 'Хотя бы одно из rightsProfileId / rightsIntakeId' })
  @IsOptional()
  @IsUUID()
  rightsProfileId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  rightsIntakeId?: string;

  @ApiPropertyOptional({ description: 'Проверка агента, из-за которой возникла эскалация' })
  @IsOptional()
  @IsUUID()
  rightsReviewId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  bookId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  bookVersionId?: string;

  @ApiPropertyOptional({ description: 'Навигационная ссылка на претензию фазы 16' })
  @IsOptional()
  @IsUUID()
  rightsClaimId?: string;

  @ApiPropertyOptional({ enum: RightsLawyerReviewTrigger })
  @IsOptional()
  @IsEnum(RightsLawyerReviewTrigger)
  trigger?: RightsLawyerReviewTrigger;

  @ApiProperty({ minLength: 3, maxLength: 300 })
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  titleRu!: string;

  @ApiProperty({ minLength: 10, maxLength: 5000 })
  @IsString()
  @MinLength(10)
  @MaxLength(5000)
  questionRu!: string;

  @ApiPropertyOptional({ maxLength: 20000 })
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  contextRu?: string;

  @ApiPropertyOptional({ type: [String], description: 'ISO 3166-1 alpha-2' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(250)
  @IsString({ each: true })
  affectedCountryCodes?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  affectedLanguages?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID(undefined, { each: true })
  affectedComponentIds?: string[];

  @ApiPropertyOptional({ enum: RightsRiskLevel, description: 'Если не задан — вычисляется' })
  @IsOptional()
  @IsEnum(RightsRiskLevel)
  riskLevel?: RightsRiskLevel;

  @ApiPropertyOptional({ description: 'По умолчанию — из политики высокого риска' })
  @Transform(toBoolean)
  @IsOptional()
  @IsBoolean()
  blocksApproval?: boolean;

  @ApiPropertyOptional({ description: 'ISO 8601; не в прошлом' })
  @IsOptional()
  @IsISO8601()
  dueAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assignedLawyerId?: string;
}

/** POST /admin/rights/profiles/:id/require-lawyer-review — короткая форма. */
export class RequireLawyerReviewDto {
  @ApiPropertyOptional({ description: 'Если не задан — генерируется из факторов риска' })
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(5000)
  questionRu?: string;

  @ApiPropertyOptional({ description: 'ISO 8601; не в прошлом' })
  @IsOptional()
  @IsISO8601()
  dueAt?: string;

  @ApiPropertyOptional()
  @Transform(toBoolean)
  @IsOptional()
  @IsBoolean()
  blocksApproval?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assignedLawyerId?: string;
}

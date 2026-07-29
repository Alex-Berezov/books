import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
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
  ValidateNested,
} from 'class-validator';
import { LAWYER_MIN_REASON_LENGTH } from '../rights-lawyer.constants';
import { RightsLawyerDecision } from '../rights-lawyer-interface';

const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true' || value === '1' || value === true) return true;
  if (value === 'false' || value === '0' || value === false) return false;
  return value;
};

/** Обязательное условие из положительного заключения с условиями. */
export class CreateConditionDto {
  @ApiProperty({ description: 'Машинный код: REMOVE_ILLUSTRATIONS, GEO_BLOCK_US, …' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  code!: string;

  @ApiProperty({ minLength: 3, maxLength: 5000 })
  @IsString()
  @MinLength(3)
  @MaxLength(5000)
  textRu!: string;

  @ApiPropertyOptional({ default: true })
  @Transform(toBoolean)
  @IsOptional()
  @IsBoolean()
  isBlocking?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(250)
  @IsString({ each: true })
  affectedCountryCodes?: string[];
}

export class DecideLawyerReviewDto {
  @ApiProperty({ enum: RightsLawyerDecision })
  @IsEnum(RightsLawyerDecision)
  decision!: RightsLawyerDecision;

  @ApiProperty({ description: 'Обязателен — источник снимка имени юриста' })
  @IsUUID()
  lawyerId!: string;

  @ApiProperty({ minLength: LAWYER_MIN_REASON_LENGTH, maxLength: 20000 })
  @IsString()
  @MinLength(LAWYER_MIN_REASON_LENGTH)
  @MaxLength(20000)
  opinionSummaryRu!: string;

  @ApiPropertyOptional({ maxLength: 20000 })
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  restrictionsRu?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(250)
  @IsString({ each: true })
  approvedCountryCodes?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(250)
  @IsString({ each: true })
  blockedCountryCodes?: string[];

  @ApiPropertyOptional({ description: 'ISO 8601; не в прошлом' })
  @IsOptional()
  @IsISO8601()
  validUntil?: string;

  @ApiPropertyOptional({ type: [CreateConditionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CreateConditionDto)
  conditions?: CreateConditionDto[];
}

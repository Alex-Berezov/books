import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { MONEY_DOC, MONEY_PATTERN, toMoneyString } from './llm-money';

export class UpdateLlmStageSettingDto {
  @ApiProperty({ type: String, description: 'Model id from GET /admin/llm/models' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  model!: string;

  @ApiPropertyOptional({ type: [String], description: 'Fallback model ids in order' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(200, { each: true })
  fallbacks?: string[];

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 0, maximum: 2 })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 1, maximum: 200000 })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200_000)
  maxTokens?: number | null;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    ...MONEY_DOC,
    nullable: true,
    description: 'Price cap per million tokens; required for a model without a fixed price',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Transform(toMoneyString)
  @Matches(MONEY_PATTERN, {
    message: 'maxPricePerMTok must be a non-negative amount with up to 8 decimals',
  })
  maxPricePerMTok?: string | null;
}

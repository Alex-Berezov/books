import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { LAWYER_LIST_DEFAULT_LIMIT, LAWYER_LIST_MAX_LIMIT } from '../rights-lawyer.constants';
import { RightsLawyerType } from '../rights-lawyer-interface';

/** Query strings arrive as `'true'` / `'1'`; class-validator needs a real boolean. */
const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true' || value === '1' || value === true) return true;
  if (value === 'false' || value === '0' || value === false) return false;
  return value;
};

export class ListLawyersDto {
  @ApiPropertyOptional({ description: 'Поиск по имени, организации, email' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ enum: RightsLawyerType })
  @IsOptional()
  @IsEnum(RightsLawyerType)
  lawyerType?: RightsLawyerType;

  @ApiPropertyOptional()
  @Transform(toBoolean)
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: 'ISO 3166-1 alpha-2' })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  jurisdictionCode?: string;

  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: LAWYER_LIST_DEFAULT_LIMIT })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(LAWYER_LIST_MAX_LIMIT)
  limit?: number = LAWYER_LIST_DEFAULT_LIMIT;
}

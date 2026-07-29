import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { LAWYER_LIST_DEFAULT_LIMIT, LAWYER_LIST_MAX_LIMIT } from '../rights-lawyer.constants';
import {
  RightsLawyerDecision,
  RightsLawyerReviewStatus,
  RightsLawyerReviewTrigger,
  RightsRiskLevel,
} from '../rights-lawyer-interface';

const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true' || value === '1' || value === true) return true;
  if (value === 'false' || value === '0' || value === false) return false;
  return value;
};

export class ListLawyerReviewsDto {
  @ApiPropertyOptional({ enum: RightsLawyerReviewStatus })
  @IsOptional()
  @IsEnum(RightsLawyerReviewStatus)
  status?: RightsLawyerReviewStatus;

  @ApiPropertyOptional({ enum: RightsLawyerReviewTrigger })
  @IsOptional()
  @IsEnum(RightsLawyerReviewTrigger)
  trigger?: RightsLawyerReviewTrigger;

  @ApiPropertyOptional({ enum: RightsRiskLevel })
  @IsOptional()
  @IsEnum(RightsRiskLevel)
  riskLevel?: RightsRiskLevel;

  @ApiPropertyOptional({ enum: RightsLawyerDecision })
  @IsOptional()
  @IsEnum(RightsLawyerDecision)
  decision?: RightsLawyerDecision;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assignedLawyerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  rightsIntakeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  rightsProfileId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  bookId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  bookVersionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  rightsClaimId?: string;

  @ApiPropertyOptional()
  @Transform(toBoolean)
  @IsOptional()
  @IsBoolean()
  blocksApproval?: boolean;

  @ApiPropertyOptional({ description: 'Только открытые просроченные проверки' })
  @Transform(toBoolean)
  @IsOptional()
  @IsBoolean()
  overdueOnly?: boolean;

  @ApiPropertyOptional({ description: 'Только проверки без назначенного юриста' })
  @Transform(toBoolean)
  @IsOptional()
  @IsBoolean()
  unassignedOnly?: boolean;

  @ApiPropertyOptional({ description: 'Заключения, истекающие в течение N дней' })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  expiringWithinDays?: number;

  @ApiPropertyOptional({
    description:
      'Только проверки, назначенные на юриста текущего пользователя. Для не-юриста список пуст.',
  })
  @Transform(toBoolean)
  @IsOptional()
  @IsBoolean()
  mine?: boolean;

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

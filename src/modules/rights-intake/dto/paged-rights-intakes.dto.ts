import { RightsReviewImportStatus } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RightsIntakeResponseDto } from './rights-intake-response.dto';

/**
 * Сводка по текущему импорту отчёта агента. Появляется только при `includeSummary=true`:
 * `RightsIntakeService.list` подмешивает её вместо самой связи `reviewImports`, отдавая
 * счётчики вместо массивов `validationErrors`/`validationWarnings`.
 */
export class RightsIntakeReviewImportSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: RightsReviewImportStatus }) importStatus!: RightsReviewImportStatus;
  @ApiProperty() isCurrent!: boolean;
  @ApiProperty() validationErrorsCount!: number;
  @ApiProperty() validationWarningsCount!: number;
  @ApiProperty() createdAt!: string;
}

/**
 * Сводка по текущему профилю прав. Счётчики стран и действий считаются в сервисе по
 * связям `territoryDecisions` и `actions`; сами связи наружу не отдаются.
 */
export class RightsIntakeRightsProfileSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() status!: string;
  @ApiProperty() overallStatus!: string;
  @ApiProperty() publicationGate!: string;
  @ApiProperty() confidence!: string;
  @ApiProperty() blockedCountriesCount!: number;
  @ApiProperty() licenseRequiredCountriesCount!: number;
  @ApiProperty() geoBlockRequiredCount!: number;
  @ApiProperty() blockingActionsCount!: number;
}

/**
 * Элемент списка интейков: та же запись `RightsIntake`, что и в карточке, плюс две сводки —
 * но только когда запрошен `includeSummary=true`. Без него сервис отдаёт запись как есть,
 * и обоих полей в ответе нет вовсе (не `null`, а отсутствуют).
 */
export class RightsIntakeListItemDto extends RightsIntakeResponseDto {
  @ApiPropertyOptional({ type: RightsIntakeReviewImportSummaryDto, nullable: true })
  currentReviewImport?: RightsIntakeReviewImportSummaryDto | null;

  @ApiPropertyOptional({ type: RightsIntakeRightsProfileSummaryDto, nullable: true })
  currentRightsProfile?: RightsIntakeRightsProfileSummaryDto | null;
}

/**
 * Ответ `GET /admin/rights/intakes`. Форма обёртки — `{items,total,page,limit}`, ровно та,
 * что собирает `RightsIntakeService.list`.
 */
export class PagedRightsIntakesDto {
  @ApiProperty({ type: RightsIntakeListItemDto, isArray: true })
  items!: RightsIntakeListItemDto[];

  @ApiProperty({ example: 42 }) total!: number;
  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 20 }) limit!: number;
}

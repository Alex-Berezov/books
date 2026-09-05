import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsInt, IsString, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ValidationIssueDto } from './rights-review-import-validation.dto';

/**
 * Поля, общие для списка и карточки импорта.
 *
 * 🔴 Выделены 05.09.2026: до этого карточка наследовала **элемент списка**,
 * то есть обещала `validationErrorsCount` и `validationWarningsCount`, которых
 * `RightsReviewImportService.getById` (`rights-review-import.service.ts:259-297`)
 * не собирает вовсе — он отдаёт вместо них сами массивы. Пока DTO не был
 * привязан ни к одному маршруту, расхождение не проверялось ничем; на живом
 * маршруте оно означало бы `undefined` в счётчике ошибок, то есть импорт
 * с ошибками валидации выглядел бы чистым (найдено ревью, `LEGACY-133`).
 */
export class RightsReviewImportBaseDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsIntakeId!: string;
  @ApiProperty() schemaVersion!: string | null;
  @ApiProperty() importStatus!: string;
  @ApiProperty() isCurrent!: boolean;
  @ApiProperty() sourceFileName!: string | null;
  @ApiProperty() importedByUserId!: string | null;
  @ApiProperty() supersededAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

/** Элемент списка: счётчики считает только `listByIntake` (`:229-230`). */
export class RightsReviewImportListItemDto extends RightsReviewImportBaseDto {
  @ApiProperty() validationErrorsCount!: number;
  @ApiProperty() validationWarningsCount!: number;
}

export class RightsReviewImportDetailDto extends RightsReviewImportBaseDto {
  @ApiProperty() reportJson!: unknown;
  @ApiProperty() reportMarkdown!: string | null;
  @ApiProperty() rawAgentOutput!: string | null;
  @ApiProperty() reportJsonSha256!: string | null;
  @ApiProperty() reportMarkdownSha256!: string | null;
  @ApiProperty() rawAgentOutputSha256!: string | null;

  /**
   * WP-9.2 (R4-02): PDF-отчёт. Ключ хранилища наружу не отдаётся — файл скачивается через
   * `GET /admin/rights/review-imports/:importId/report-pdf` под ролями Admin/ContentManager.
   */
  @ApiProperty({ description: 'PDF-версия отчёта загружена' }) hasReportPdf!: boolean;
  @ApiProperty() reportPdfSha256!: string | null;
  @ApiProperty() reportPdfFileName!: string | null;
  @ApiProperty() reportPdfContentType!: string | null;
  @ApiProperty() reportPdfSizeBytes!: number | null;
  @ApiProperty() reportPdfUploadedAt!: string | null;

  /** WP-9.1 (essence §15): под каким заданием и чем сделан отчёт. */
  @ApiProperty() inputManifestSha256!: string | null;
  @ApiProperty() inputManifestVersion!: string | null;
  @ApiProperty() promptVersion!: string | null;
  @ApiProperty() agentModel!: string | null;

  @ApiProperty({ type: [ValidationIssueDto] }) validationErrors!: ValidationIssueDto[] | null;
  @ApiProperty({ type: [ValidationIssueDto] }) validationWarnings!: ValidationIssueDto[] | null;
}

export class ListRightsReviewImportsRequestDto {
  @ApiPropertyOptional({ description: 'Page number', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'Filter by import status' })
  @IsOptional()
  @IsString()
  status?: string;
}

export class RightsReviewImportsListResponseDto {
  @ApiProperty({ type: [RightsReviewImportListItemDto] })
  items!: RightsReviewImportListItemDto[];

  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

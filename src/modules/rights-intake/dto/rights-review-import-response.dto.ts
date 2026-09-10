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
  @ApiProperty({ type: String, nullable: true }) schemaVersion!: string | null;
  @ApiProperty() importStatus!: string;
  @ApiProperty() isCurrent!: boolean;
  @ApiProperty({ type: String, nullable: true }) sourceFileName!: string | null;
  @ApiProperty({ type: String, nullable: true }) importedByUserId!: string | null;
  @ApiProperty({ type: String, nullable: true }) supersededAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

/** Элемент списка: счётчики считает только `listByIntake` (`:229-230`). */
export class RightsReviewImportListItemDto extends RightsReviewImportBaseDto {
  @ApiProperty() validationErrorsCount!: number;
  @ApiProperty() validationWarningsCount!: number;
}

export class RightsReviewImportDetailDto extends RightsReviewImportBaseDto {
  @ApiProperty({ type: 'object', additionalProperties: true })
  reportJson!: unknown;

  @ApiProperty({ type: String, nullable: true }) reportMarkdown!: string | null;
  @ApiProperty({ type: String, nullable: true }) rawAgentOutput!: string | null;
  @ApiProperty({ type: String, nullable: true }) reportJsonSha256!: string | null;
  @ApiProperty({ type: String, nullable: true }) reportMarkdownSha256!: string | null;
  @ApiProperty({ type: String, nullable: true }) rawAgentOutputSha256!: string | null;

  /**
   * WP-9.2 (R4-02): PDF-отчёт. Ключ хранилища наружу не отдаётся — файл скачивается через
   * `GET /admin/rights/review-imports/:importId/report-pdf` под ролями Admin/ContentManager.
   */
  @ApiProperty({ description: 'PDF-версия отчёта загружена' }) hasReportPdf!: boolean;
  @ApiProperty({ type: String, nullable: true }) reportPdfSha256!: string | null;
  @ApiProperty({ type: String, nullable: true }) reportPdfFileName!: string | null;
  @ApiProperty({ type: String, nullable: true }) reportPdfContentType!: string | null;
  @ApiProperty({ type: Number, nullable: true }) reportPdfSizeBytes!: number | null;
  @ApiProperty({ type: String, nullable: true }) reportPdfUploadedAt!: string | null;

  /** WP-9.1 (essence §15): под каким заданием и чем сделан отчёт. */
  @ApiProperty({ type: String, nullable: true }) inputManifestSha256!: string | null;
  @ApiProperty({ type: String, nullable: true }) inputManifestVersion!: string | null;
  @ApiProperty({ type: String, nullable: true }) promptVersion!: string | null;
  @ApiProperty({ type: String, nullable: true }) agentModel!: string | null;

  @ApiProperty({ type: [ValidationIssueDto], nullable: true })
  validationErrors!: ValidationIssueDto[] | null;

  @ApiProperty({ type: [ValidationIssueDto], nullable: true })
  validationWarnings!: ValidationIssueDto[] | null;
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

/**
 * Запись импорта целиком — то, что отдаёт `POST /admin/rights/intakes/:id/review-imports`.
 *
 * 🔴 Это НЕ карточка `RightsReviewImportDetailDto`: маршрут создания возвращает
 * строку таблицы `RightsReviewImport` как есть (`rights-review-import.service.ts`,
 * ветка `VALIDATION_FAILED` и хвост транзакции), без отбора полей и без
 * преобразований. Поэтому здесь есть ключи приватного хранилища
 * (`reportJsonStorageKey` и соседние), которых карточка намеренно не показывает,
 * а даты приходят датами, а не строками ISO. Поля перечислены по модели
 * `RightsReviewImport` в `prisma/schema.prisma` — все скалярные колонки,
 * связей запрос не раскрывает.
 */
export class RightsReviewImportRecordDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsIntakeId!: string;
  @ApiProperty({ type: String, nullable: true }) schemaVersion!: string | null;

  @ApiProperty({ enum: ['VALIDATED', 'VALIDATION_FAILED', 'SUPERSEDED'] })
  importStatus!: string;

  @ApiProperty() isCurrent!: boolean;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Отчёт агента как есть',
  })
  reportJson!: unknown;

  @ApiProperty({ type: String, nullable: true }) reportMarkdown!: string | null;
  @ApiProperty({ type: String, nullable: true }) rawAgentOutput!: string | null;
  @ApiProperty({ type: String, nullable: true }) sourceFileName!: string | null;
  @ApiProperty({ type: String, nullable: true }) reportJsonSha256!: string | null;
  @ApiProperty({ type: String, nullable: true }) reportMarkdownSha256!: string | null;
  @ApiProperty({ type: String, nullable: true }) rawAgentOutputSha256!: string | null;

  @ApiProperty({ type: String, nullable: true }) reportJsonStorageKey!: string | null;
  @ApiProperty({ type: String, nullable: true }) reportMarkdownStorageKey!: string | null;
  @ApiProperty({ type: String, nullable: true }) rawAgentOutputStorageKey!: string | null;

  @ApiProperty({ type: String, nullable: true }) reportPdfStorageKey!: string | null;
  @ApiProperty({ type: String, nullable: true }) reportPdfSha256!: string | null;
  @ApiProperty({ type: String, nullable: true }) reportPdfFileName!: string | null;
  @ApiProperty({ type: String, nullable: true }) reportPdfContentType!: string | null;
  @ApiProperty({ type: Number, nullable: true }) reportPdfSizeBytes!: number | null;
  @ApiProperty({ type: Date, nullable: true }) reportPdfUploadedAt!: Date | null;
  @ApiProperty({ type: String, nullable: true }) reportPdfUploadedByUserId!: string | null;

  @ApiProperty({ type: String, nullable: true }) inputManifestStorageKey!: string | null;
  @ApiProperty({ type: String, nullable: true }) inputManifestSha256!: string | null;
  @ApiProperty({ type: String, nullable: true }) inputManifestVersion!: string | null;
  @ApiProperty({ type: String, nullable: true }) promptVersion!: string | null;
  @ApiProperty({ type: String, nullable: true }) agentModel!: string | null;

  @ApiProperty({ type: [ValidationIssueDto], nullable: true })
  validationErrors!: unknown;

  @ApiProperty({ type: [ValidationIssueDto], nullable: true })
  validationWarnings!: unknown;

  @ApiProperty({ type: String, nullable: true }) importedByUserId!: string | null;
  @ApiProperty({ type: Date, nullable: true }) supersededAt!: Date | null;
  @ApiProperty({ type: Date }) createdAt!: Date;
  @ApiProperty({ type: Date }) updatedAt!: Date;
}

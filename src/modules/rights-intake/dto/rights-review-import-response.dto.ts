import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsInt, IsString, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ValidationIssueDto } from './rights-review-import-validation.dto';

export class RightsReviewImportListItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() rightsIntakeId!: string;
  @ApiProperty() schemaVersion!: string | null;
  @ApiProperty() importStatus!: string;
  @ApiProperty() isCurrent!: boolean;
  @ApiProperty() sourceFileName!: string | null;
  @ApiProperty() validationErrorsCount!: number;
  @ApiProperty() validationWarningsCount!: number;
  @ApiProperty() importedByUserId!: string | null;
  @ApiProperty() supersededAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class RightsReviewImportDetailDto extends RightsReviewImportListItemDto {
  @ApiProperty() reportJson!: unknown;
  @ApiProperty() reportMarkdown!: string | null;
  @ApiProperty() rawAgentOutput!: string | null;
  @ApiProperty() reportJsonSha256!: string | null;
  @ApiProperty() reportMarkdownSha256!: string | null;
  @ApiProperty() rawAgentOutputSha256!: string | null;
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
  items!: RightsReviewImportListItemDto[];
  total!: number;
  page!: number;
  limit!: number;
}

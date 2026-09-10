import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Response of `POST /admin/media/cleanup-orphans` — mirrors `CleanupResult` from
 * `media-cleanup.service.ts`. */
export class CleanupOrphansResponseDto {
  @ApiProperty() markedSoftDeleted!: number;
  @ApiProperty() hardDeleted!: number;
  @ApiProperty() storageFilesRemoved!: number;
  @ApiProperty() storageErrors!: number;
  @ApiPropertyOptional({ type: [String] }) softDeletedCandidates?: string[];
  @ApiPropertyOptional({ type: [String] }) hardDeletedCandidates?: string[];
}

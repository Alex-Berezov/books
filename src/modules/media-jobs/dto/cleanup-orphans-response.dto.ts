import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Response of `POST /admin/media/cleanup-orphans` — mirrors `CleanupResult` from
 * `media-cleanup.service.ts`. */
export class CleanupOrphansResponseDto {
  @ApiProperty() markedSoftDeleted!: number;
  @ApiProperty() hardDeleted!: number;
  @ApiProperty() storageFilesRemoved!: number;
  @ApiProperty() storageErrors!: number;
  @ApiProperty({
    description:
      'How many assets the run looked at. Without it "deleted 0" is indistinguishable from a run that scanned nothing.',
  })
  scanned!: number;
  @ApiProperty({ description: 'Of those scanned: how many the URL-reference check saved.' })
  skippedByUrlReference!: number;
  @ApiPropertyOptional({ type: [String] }) softDeletedCandidates?: string[];
  @ApiPropertyOptional({ type: [String] }) hardDeletedCandidates?: string[];
}

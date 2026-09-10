import { ApiProperty } from '@nestjs/swagger';

/**
 * Response of `POST /media/confirm` and `POST /media/upload` — the raw `MediaAsset` row
 * as returned by `prisma.mediaAsset.create`/`update` (no `select`, scalar fields only,
 * relations are never included by `MediaService.confirm`).
 */
export class MediaAssetResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() key!: string;
  @ApiProperty() url!: string;
  @ApiProperty({ type: String, nullable: true }) contentType!: string | null;
  @ApiProperty({ type: Number, nullable: true }) size!: number | null;
  @ApiProperty({ type: Number, nullable: true }) width!: number | null;
  @ApiProperty({ type: Number, nullable: true }) height!: number | null;
  @ApiProperty({ type: Number, nullable: true }) duration!: number | null;
  @ApiProperty({ type: String, nullable: true }) hash!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, nullable: true }) createdById!: string | null;
  @ApiProperty() isDeleted!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) deletedAt!: Date | null;
}

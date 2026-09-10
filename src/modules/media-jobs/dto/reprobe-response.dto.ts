import { ApiProperty } from '@nestjs/swagger';

/** Response of `POST /admin/media/reprobe` — see `MediaProbeService.reprobeAll`. */
export class ReprobeResponseDto {
  @ApiProperty({ type: Number, description: 'Number of audio MediaAssets enqueued for ffprobe' })
  enqueued!: number;
}

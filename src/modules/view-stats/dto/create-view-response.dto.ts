import { ApiProperty } from '@nestjs/swagger';

/** Response of `POST /views` — mirrors `ViewStatsService.create`'s return type. */
export class CreateViewResponseDto {
  @ApiProperty({ type: Boolean, example: true })
  success!: true;
}

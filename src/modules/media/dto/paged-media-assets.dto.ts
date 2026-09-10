import { ApiProperty } from '@nestjs/swagger';
import { MediaAssetResponseDto } from './media-asset-response.dto';

/**
 * Ответ `GET /media`. `MediaService.list` делает `findMany` без `select`, то есть отдаёт
 * те же скалярные поля `MediaAsset`, что и `POST /media/confirm`; связи не подгружаются.
 * Форма обёртки — `{items,total,page,limit}`.
 */
export class PagedMediaAssetsDto {
  @ApiProperty({ type: MediaAssetResponseDto, isArray: true })
  items!: MediaAssetResponseDto[];

  @ApiProperty({ example: 42 }) total!: number;
  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 20 }) limit!: number;
}

import { ApiProperty } from '@nestjs/swagger';

/**
 * ⚠️ `email` сюда не возвращается: отзывы видны анониму, и почта комментатора
 * уезжала вместе с ними (`LEGACY-089`). Если модерации понадобится почта, её
 * место — административный маршрут под гвардом, а не публичный контракт.
 */
export class CommentUserDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String, nullable: true, required: false })
  name?: string | null;

  @ApiProperty({ type: String, nullable: true, required: false })
  nickname?: string | null;

  @ApiProperty({ type: String, nullable: true, required: false })
  avatarUrl?: string | null;
}

import { ApiProperty } from '@nestjs/swagger';

/**
 * ⚠️ `email` сюда не возвращается: отзывы видны анониму, и почта комментатора
 * уезжала вместе с ними (`LEGACY-089`). Если модерации понадобится почта, её
 * место — административный маршрут под гвардом, а не публичный контракт.
 */
export class CommentUserDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ required: false, nullable: true })
  name?: string | null;

  @ApiProperty({ required: false, nullable: true })
  nickname?: string | null;

  @ApiProperty({ required: false, nullable: true })
  avatarUrl?: string | null;
}

import { ApiProperty } from '@nestjs/swagger';
import { BookWorldImageDto } from '../../book-world/dto/book-world-response.dto';

/** Файл картинки для админки: публичный адрес, размеры из заголовка и id медиа (для «Accept»). */
export class WorldImageFileDto extends BookWorldImageDto {
  @ApiProperty({ type: String })
  mediaId!: string;
}

/**
 * Иллюстрация героя во вкладке World (`F08-11a`, решения арбитра `F08 | F08-11` Р3, Р5): принятая
 * (её видит сайт) и ожидающая («Accept» администратора). Генерации моделью нет (`F08-11d-1`).
 */
export class WorldImageStateDto {
  @ApiProperty({ type: String, description: 'Entity key: one illustration per book and key' })
  key!: string;

  @ApiProperty({
    type: Boolean,
    description:
      'The entity may have an illustration: a main or secondary character (the appearance text is not a condition)',
  })
  allowed!: boolean;

  @ApiProperty({
    type: Boolean,
    description:
      'The entity type and role allow an illustration (main or secondary character); equals allowed since F08-11d-1: ' +
      'false — Accept answers 409 WORLD_IMAGE_NOT_ALLOWED (F08-12a, tail of F08-11b)',
  })
  roleAllowed!: boolean;

  @ApiProperty({
    type: WorldImageFileDto,
    nullable: true,
    description: 'Accepted: shown on the site',
  })
  accepted!: WorldImageFileDto | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  acceptedAt!: Date | null;

  @ApiProperty({
    type: WorldImageFileDto,
    nullable: true,
    description: 'Waiting for acceptance: never shown on the site',
  })
  pending!: WorldImageFileDto | null;
}

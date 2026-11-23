import { ApiProperty } from '@nestjs/swagger';
import { LlmOperationStatus } from '@prisma/client';
import { BookWorldImageDto } from '../../book-world/dto/book-world-response.dto';

/** Файл картинки для админки: публичный адрес, размеры из заголовка и id медиа (для «Accept»). */
export class WorldImageFileDto extends BookWorldImageDto {
  @ApiProperty({ type: String })
  mediaId!: string;
}

/** Последняя генерация: статус её операции и причина отказа - код задачи (`lastError`). */
export class WorldImageGenerationDto {
  @ApiProperty({ type: String })
  operationId!: string;

  @ApiProperty({ enum: LlmOperationStatus, enumName: 'LlmOperationStatus' })
  status!: LlmOperationStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why the generation failed: WORLD_IMAGE_NOT_IMAGE (the answer is not PNG/JPEG/WEBP), WORLD_IMAGE_TOO_SMALL ' +
      '(narrower than 1200 px), WORLD_IMAGE_TOO_LARGE, WORLD_IMAGE_INPUT_MISSING, or an LLM code ' +
      '(LLM_INSUFFICIENT_FUNDS, LLM_UNAVAILABLE...); null while it runs or after success',
  })
  failedReason!: string | null;

  @ApiProperty({ type: String, description: 'Spent on this generation, USD (decimal string)' })
  spentUsd!: string;
}

/**
 * Иллюстрация героя во вкладке World (`F08-11a`, решения арбитра `F08 | F08-11` Р3, Р5): принятая
 * (её видит сайт), ожидающая (результат генерации до «Accept») и последняя генерация.
 */
export class WorldImageStateDto {
  @ApiProperty({ type: String, description: 'Entity key: one illustration per book and key' })
  key!: string;

  @ApiProperty({
    type: Boolean,
    description:
      'The entity may have an illustration: a main or secondary character with appearance text',
  })
  allowed!: boolean;

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
    description: 'Generated and waiting for acceptance: never shown on the site',
  })
  pending!: WorldImageFileDto | null;

  @ApiProperty({ type: WorldImageGenerationDto, nullable: true })
  generation!: WorldImageGenerationDto | null;

  @ApiProperty({
    type: String,
    description:
      'Upper bound of one generation, USD (decimal string): the reserve of one image for the primary model and each fallback of the stage',
  })
  estimateUsd!: string;
}

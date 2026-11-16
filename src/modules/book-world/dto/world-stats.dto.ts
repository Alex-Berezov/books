import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Language, WorldStatEvent } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Key } from '../../../shared/validators/block-fields.decorator';
import { BOOK_WORLD_KEY_REGEX } from './book-world-blocks.dto';

/**
 * Событие публичной страницы мира книги (F08-3, `product.md` §14; решение арбитра `F08 | F08-3` Q5).
 * Без идентификатора посетителя: версия, ключ сущности (нет — общая страница) и вид события.
 */
export class WorldBeaconDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  bookVersionId!: string;

  @ApiPropertyOptional({
    type: String,
    pattern: BOOK_WORLD_KEY_REGEX.source,
    description: 'Entity key; absent — the /wiki page',
  })
  @IsOptional()
  @Key()
  key?: string;

  @ApiProperty({
    enum: WorldStatEvent,
    enumName: 'WorldStatEvent',
    description:
      'view — page view; to_* — a link followed (reader, audio, world, analysis, summary); ' +
      'engaged — the first link followed on this page load, sent once per load',
  })
  @IsEnum(WorldStatEvent)
  event!: WorldStatEvent;
}

/** Окно отчёта: последние `days` суток по UTC, сегодняшние включительно. */
export const WORLD_STATS_MAX_DAYS = 366;
export const WORLD_STATS_DEFAULT_DAYS = 30;

export class WorldStatsQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid', description: 'One version; absent — all' })
  @IsOptional()
  @IsUUID()
  bookVersionId?: string;

  @ApiPropertyOptional({
    type: Number,
    default: WORLD_STATS_DEFAULT_DAYS,
    minimum: 1,
    maximum: WORLD_STATS_MAX_DAYS,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(WORLD_STATS_MAX_DAYS)
  days?: number = WORLD_STATS_DEFAULT_DAYS;
}

export class WorldStatsRowDto {
  @ApiProperty({ type: String, format: 'uuid' })
  bookVersionId!: string;

  @ApiProperty({
    enum: Language,
    enumName: 'Language',
    nullable: true,
    description:
      'Language of the version; null only if the version was deleted between the sum and the lookup (rows go away with it)',
  })
  language!: Language | null;

  @ApiProperty({ type: String, nullable: true, description: 'Version slug' })
  slug!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Entity key; null — the /wiki page' })
  key!: string | null;

  @ApiProperty({ enum: WorldStatEvent, enumName: 'WorldStatEvent' })
  event!: WorldStatEvent;

  @ApiProperty({ type: Number, description: 'Sum over the window' })
  count!: number;
}

export class WorldStatsResponseDto {
  @ApiProperty({ type: String, format: 'date', description: 'First day of the window (UTC)' })
  from!: string;

  @ApiProperty({ type: String, format: 'date', description: 'Last day of the window (UTC), today' })
  to!: string;

  @ApiProperty({
    type: Boolean,
    description: 'The report hit its row cap; narrow it with bookVersionId or days',
  })
  isTruncated!: boolean;

  @ApiProperty({ type: [WorldStatsRowDto] })
  items!: WorldStatsRowDto[];
}

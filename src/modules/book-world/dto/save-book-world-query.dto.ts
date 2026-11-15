import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { BOOK_WORLD_LIMITS } from './book-world-blocks.dto';
import { ExpectedRowQueryDto } from '../../../shared/dto/expected-updated-at-query.dto';

/**
 * Query записи мира книги. У `PUT .../world` сверка — по всей версии (решение арбитра `F08 | F08-1`
 * R6): `expectedUpdatedAt` — наибольший `updatedAt` сущностей версии, `expectedAbsent` — сущностей
 * нет; у `PUT .../world/:key` — по самой сущности. Оба поля вместе — 400.
 */
export class SaveBookWorldQueryDto extends ExpectedRowQueryDto {
  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description:
      'Validate and merge exactly as a save would (references, chapters, verbatim quotes), write nothing, return hasCore and warnings; expectedUpdatedAt and expectedAbsent are not checked',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  dryRun?: 'true' | 'false';
}

/**
 * Query `PUT .../world` (вся версия): к `expectedUpdatedAt` (наибольший `updatedAt`) — `expectedCount`,
 * число сущностей, которое видела вкладка. Удаление сущности наибольший `updatedAt` может не сдвинуть,
 * а число — сдвигает (решение арбитра 15.11.2026). С `expectedAbsent` — 400.
 */
export class SaveBookWorldVersionQueryDto extends SaveBookWorldQueryDto {
  @ApiPropertyOptional({
    type: Number,
    minimum: 0,
    maximum: BOOK_WORLD_LIMITS.entities,
    description:
      'Number of entities of the version the tab saw; another number - 409 RECORD_CHANGED; with expectedAbsent - 400',
  })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(BOOK_WORLD_LIMITS.entities)
  expectedCount?: number;
}

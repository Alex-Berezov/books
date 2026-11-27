import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

/**
 * Query списка мира (`F08-12d`, решение арбитра `F08 | F08-12d` Р3): литературную карту считает
 * только страница `/wiki` - тайлы OSM берутся лишь там, где карту видят. Прочие страницы (книга,
 * анализ, пересказ) зовут список без параметра и тайлов не трогают.
 */
export class ListBookWorldQueryDto {
  @ApiPropertyOptional({
    enum: ['1', 'true'],
    description: 'Build the literary map (readers only); any other value - 400',
  })
  @IsOptional()
  @IsIn(['1', 'true'])
  map?: '1' | 'true';
}

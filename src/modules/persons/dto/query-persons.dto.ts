import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Language } from '@prisma/client';
import { ContributorRole, PersonType } from '../person-interface';

export class QueryPersonsDto {
  @ApiPropertyOptional({
    description: 'Search term for name, sortName, translation, or authority identifiers',
  })
  @IsString()
  @IsOptional()
  q?: string;

  @ApiPropertyOptional({ enum: ContributorRole })
  @IsEnum(ContributorRole)
  @IsOptional()
  role?: ContributorRole;

  @ApiPropertyOptional({ enum: PersonType })
  @IsEnum(PersonType)
  @IsOptional()
  type?: PersonType;

  @ApiPropertyOptional({ enum: Language })
  @IsEnum(Language)
  @IsOptional()
  language?: Language;

  @ApiPropertyOptional({ default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number = 20;

  /**
   * Смещение от начала выдачи. Остаётся во входе ради обратной совместимости:
   * менять то, что шлёт клиент, задача `LEGACY-177` не разрешает.
   *
   * ⚠️ Смещение, не кратное `limit`, выравнивается вниз до границы страницы
   * (`PersonsService.findAll`). Иначе тело ответа сообщало бы `page`, под
   * которым лежит другое окно строк, и клиент, идущий по `pagination.page`,
   * пропускал бы часть выдачи (решение арбитра 13.09.2026).
   */
  @ApiPropertyOptional({ default: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  offset?: number = 0;

  /**
   * Номер страницы, 1-based. Приоритетнее `offset`: заданы оба — выигрывает
   * `page`, 400 в этом случае не отдаётся (решение арбитра 13.09.2026).
   */
  @ApiPropertyOptional({ description: 'Page number, 1-based; takes priority over `offset`' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;
}

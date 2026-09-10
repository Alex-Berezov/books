import { ApiProperty } from '@nestjs/swagger';
import { PublicUserWithRolesDto } from './public-user.dto';

/**
 * Ответ `GET /users`. Форма обёртки — `{items,total,page,limit}`, та же, что у
 * соседних ручек этого модуля; сводить три формы пагинации репозитория в одну
 * здесь нельзя, это сменило бы контракт (`LEGACY-176`-`178`, тема владельца).
 */
export class PagedUsersDto {
  @ApiProperty({ type: PublicUserWithRolesDto, isArray: true })
  items!: PublicUserWithRolesDto[];

  @ApiProperty({ type: Number, example: 42 })
  total!: number;

  @ApiProperty({ type: Number, example: 1 })
  page!: number;

  @ApiProperty({ type: Number, example: 20 })
  limit!: number;
}

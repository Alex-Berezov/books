import { ApiProperty, getSchemaPath } from '@nestjs/swagger';
import type {
  ReferenceObject,
  SchemaObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';

/**
 * Единая обёртка списочного ответа (`LEGACY-177`, решение владельца 13.09.2026).
 *
 * До этого дня API отдавал списки в трёх несовместимых формах — `{items,total,page,limit}`,
 * `{data,meta}` и `{items,pagination}` — и ещё в нескольких их вариациях. Целевой
 * выбрана `{items, pagination:{page,limit,total,totalPages}}`: на ней уже сидела
 * публичная витрина карточек, и её потребители правки не требуют.
 *
 * ⚠️ Публичные маршруты этой обёрткой **не переводятся** (решение арбитра
 * 13.09.2026, `books-app-docs/ai-context/decisions-log.md`): их ответы лежат
 * в edge-кэше Cloudflare, и смена формы потребовала бы сброса кэша на боевом
 * домене. Публичный остаток ведётся отдельной записью.
 *
 * ⚠️ Обёртка ничего не считает и не режет. `skip`/`take` в маршруты, где их нет,
 * она не вводит: молчаливое усечение выдачи — это `LEGACY-098`, и вводится оно
 * вместе с сигналом неполноты, а не заодно с переименованием полей.
 */
export class PaginationInfoDto {
  @ApiProperty({ type: Number, description: 'Applied page number, 1-based' })
  page!: number;

  @ApiProperty({ type: Number, description: 'Applied page size' })
  limit!: number;

  @ApiProperty({ type: Number, description: 'Total number of rows matching the query' })
  total!: number;

  @ApiProperty({ type: Number, description: 'Total number of pages at this page size' })
  totalPages!: number;
}

/**
 * Пагинация бесконечного списка: общая форма плюс признак следующей страницы.
 *
 * ⚠️ Признак живёт **внутри** `pagination`, а не рядом с ним: снаружи обёртки
 * у списочного ответа только `items` и `pagination`. Считают его списки
 * по-разному и намеренно: полка берёт `take: limit + 1` и не платит за второй
 * запрос `count`, активности сравнивают `page * limit` с уже посчитанным
 * `total`. Поэтому признак приходит в `paginatedWithNext` готовым.
 *
 * ⚠️ Класс один на все такие списки: до 13.09.2026 их было два с одинаковым
 * набором полей и разными текстами описания, и в снимке OpenAPI они давали два
 * компонента, которые фронт читал одним типом.
 */
export class PaginationWithNextDto extends PaginationInfoDto {
  @ApiProperty({ type: Boolean, example: false, description: 'Whether a next page exists' })
  hasNext!: boolean;
}

/** Списочный ответ в единой форме. */
export interface PaginatedResult<T> {
  items: T[];
  pagination: PaginationInfoDto;
}

/**
 * Сборка ответа из уже выбранных строк и применённых значений пагинации.
 *
 * `totalPages` считается здесь, а не в каждом сервисе: девять мест считали его
 * сами, и два из них — `Math.ceil(total / limit)` при `limit = 0` — давали
 * `Infinity`. При нулевом `limit` страниц ноль.
 */
export const paginated = <T>(
  items: T[],
  { page, limit, total }: { page: number; limit: number; total: number },
): PaginatedResult<T> => ({
  items,
  pagination: {
    page,
    limit,
    total,
    totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
  },
});

/**
 * Ответ «весь список одной страницей» — для маршрутов, которые пагинацию
 * не принимают вовсе и отдают всё, что нашли.
 *
 * ⚠️ Это **не** разрешение отдавать неограниченную выдачу: такие маршруты
 * перечислены отдельной записью техдолга. Форма нужна, чтобы клиент разбирал
 * все списки одним кодом, пока настоящая пагинация до них не дошла.
 */
export const paginatedAll = <T>(items: T[]): PaginatedResult<T> =>
  paginated(items, { page: 1, limit: items.length, total: items.length });

/**
 * Схема `{items, pagination}` для `@ApiOkResponse` с конкретным типом строки.
 *
 * Дженерик-класса в Swagger не существует, поэтому обёртка описывается схемой,
 * а тип строки подставляется ссылкой. Сам тип строки обязан быть объявлен
 * в `@ApiExtraModels` того же контроллера — иначе `$ref` укажет в пустоту,
 * и снимок схемы для фронта соберётся без полей строки.
 */
export const paginatedSchema = (
  itemType: Parameters<typeof getSchemaPath>[0],
  paginationType: Parameters<typeof getSchemaPath>[0] = PaginationInfoDto,
): SchemaObject & Partial<ReferenceObject> => ({
  type: 'object',
  required: ['items', 'pagination'],
  properties: {
    items: { type: 'array', items: { $ref: getSchemaPath(itemType) } },
    pagination: { $ref: getSchemaPath(paginationType) },
  },
});

/**
 * Обёртка с `hasNext` — для бесконечных списков, где клиент листает вперёд
 * и `total` ему не нужен (`GET /me/bookshelf`, `GET /users/me/activities`).
 *
 * ⚠️ Поле живёт **внутри** `pagination`, а не рядом с ним: форма ответа
 * остаётся одна. Сам признак каждый список считает по-своему — полка берёт
 * `take: limit + 1` и не платит за второй запрос, активности сравнивают
 * `page * limit` с `total`, — поэтому он приходит сюда готовым, а не считается
 * здесь.
 */
export const paginatedWithNext = <T>(
  items: T[],
  args: { page: number; limit: number; total: number; hasNext: boolean },
): { items: T[]; pagination: PaginationWithNextDto } => {
  const base = paginated(items, args);
  return { items: base.items, pagination: { ...base.pagination, hasNext: args.hasNext } };
};

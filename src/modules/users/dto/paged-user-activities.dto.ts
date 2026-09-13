import type {
  ReferenceObject,
  SchemaObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { UserActivityDto } from './user-activity.dto';
import {
  PaginationWithNextDto,
  PaginatedResult,
  paginatedSchema,
} from '../../../shared/dto/paginated-response.dto';

/**
 * Ответ `GET /users/me/activities`: строки плюс пагинация с `hasNext`.
 *
 * ⚠️ Признак **не выброшен** при сведении формы: его читает фронт —
 * `books-front/api/hooks/useAuth.ts:105` строит по нему `getNextPageParam`
 * у `useInfiniteQuery`. Снятое поле там означало бы «активности кончились»
 * на первой же странице, то есть молчаливую пропажу данных у автора.
 */
export interface PagedUserActivities extends PaginatedResult<UserActivityDto> {
  pagination: PaginationWithNextDto;
}

/** Схема ответа для `@ApiOkResponse` — общая обёртка с пагинацией, несущей `hasNext`. */
export const pagedUserActivitiesSchema = (): SchemaObject & Partial<ReferenceObject> =>
  paginatedSchema(UserActivityDto, PaginationWithNextDto);

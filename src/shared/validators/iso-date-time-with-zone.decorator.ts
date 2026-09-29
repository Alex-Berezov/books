import { applyDecorators } from '@nestjs/common';
import { IsISO8601, Matches, ValidationOptions } from 'class-validator';

// Одна форма границы окна дат на все админские списки: журнал `GET /admin/audit-events`
// (`LEGACY-015` п.3, решение арбитра 27.09.2026) и претензии `GET /admin/rights/claims`
// (`LEGACY-426`, решение арбитра 29.09.2026). Дата без времени (`2026-09-27`) читалась бы
// полуночью UTC, и `to=<сегодня>` молча отрезал бы весь день; время без зоны - поясом сервера.
// Несуществующую дату (`02-30`, год `0000`) отсекает строгий `IsISO8601`: `new Date()` перенёс
// бы её в март.
export const ISO_DATE_TIME_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
export const ISO_DATE_TIME_WITH_ZONE_MESSAGE =
  '$property must be an ISO date-time with a time zone (e.g. 2026-09-27T00:00:00Z)';

export function IsIsoDateTimeWithZone(validationOptions?: ValidationOptions): PropertyDecorator {
  return applyDecorators(
    IsISO8601({ strict: true, strictSeparator: true }, validationOptions),
    Matches(ISO_DATE_TIME_WITH_ZONE, {
      message: ISO_DATE_TIME_WITH_ZONE_MESSAGE,
      ...validationOptions,
    }),
  );
}

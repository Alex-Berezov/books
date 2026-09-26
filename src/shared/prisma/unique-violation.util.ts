import { Prisma } from '@prisma/client';

/**
 * Поля уникального индекса, на котором упал `P2002`.
 *
 * 🔴 Под `@prisma/adapter-pg` (Prisma 7, `prisma.service.ts`) `meta.target` у `P2002` нет вовсе:
 * поля лежат в `meta.driverAdapterError.cause.constraint.fields` (живой замер 26.09.2026, пачка
 * `T55`). Разбор одного `meta.target` молча давал `[]`, и ветки «дубль слага → 400» не срабатывали.
 * `meta.target` читается первым — эту форму отдаёт клиент без адаптера.
 */
export function uniqueViolationFields(error: Prisma.PrismaClientKnownRequestError): string[] {
  const meta = error.meta as
    | {
        target?: unknown;
        driverAdapterError?: { cause?: { constraint?: { fields?: unknown } } };
      }
    | undefined;
  const target = meta?.target;
  if (Array.isArray(target)) return target.map(String);
  if (typeof target === 'string') return [target];
  const fields = meta?.driverAdapterError?.cause?.constraint?.fields;
  return Array.isArray(fields) ? fields.map(String) : [];
}

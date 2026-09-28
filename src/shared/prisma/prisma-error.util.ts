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
  if (Array.isArray(target)) return target.map(columnName);
  if (typeof target === 'string') return [columnName(target)];
  const fields = meta?.driverAdapterError?.cause?.constraint?.fields;
  return Array.isArray(fields) ? fields.map(columnName) : [];
}

/**
 * Модель, чья запись упала (`meta.modelName`); `undefined` — форма ошибки её не несёт. Нужна, чтобы `P2002`
 * чужой таблицы в той же транзакции (журнал, история слагов) не называть дублем своей сущности.
 */
export function violationModelName(
  error: Prisma.PrismaClientKnownRequestError,
): string | undefined {
  const model = (error.meta as { modelName?: unknown } | undefined)?.modelName;
  return typeof model === 'string' ? model : undefined;
}

/**
 * Адаптер берёт поля из текста ошибки Postgres (`Key ("seoId")=(5)`), а там имя в смешанном
 * регистре стоит в кавычках: без их снятия `"seoId"` не равно `seoId`, и разбор молча промахивается.
 */
const columnName = (value: unknown): string => String(value).replace(/^"(.*)"$/, '$1');

/**
 * Имя ограничения и поля, на которых упал `P2003` (внешний ключ).
 *
 * Под `@prisma/adapter-pg` верхнеуровневого `meta.constraint` нет: адаптер кладёт
 * `meta.driverAdapterError.cause.constraint` = `{ index: '<имя ограничения>' }` или `{ fields: [колонка] }`
 * (`@prisma/adapter-pg`, ветка кода `23503`). `meta.constraint` читается первым — форма клиента без адаптера.
 */
export function foreignKeyViolationTargets(error: Prisma.PrismaClientKnownRequestError): string[] {
  const meta = error.meta as
    | {
        constraint?: unknown;
        driverAdapterError?: { cause?: { constraint?: { index?: unknown; fields?: unknown } } };
      }
    | undefined;
  const targets: string[] = [];
  if (typeof meta?.constraint === 'string') targets.push(meta.constraint);
  const constraint = meta?.driverAdapterError?.cause?.constraint;
  if (typeof constraint?.index === 'string') targets.push(constraint.index);
  if (Array.isArray(constraint?.fields)) targets.push(...constraint.fields.map(columnName));
  return targets;
}

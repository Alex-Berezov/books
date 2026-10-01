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
        driverAdapterError?: { cause?: { constraint?: { fields?: unknown; index?: unknown } } };
      }
    | undefined;
  const target = meta?.target;
  if (Array.isArray(target)) return target.map(columnName);
  if (typeof target === 'string') return [columnName(target)];
  const constraint = meta?.driverAdapterError?.cause?.constraint;
  if (Array.isArray(constraint?.fields)) return constraint.fields.map(columnName);
  return typeof constraint?.index === 'string'
    ? indexFields(constraint.index, violationModelName(error))
    : [];
}

/**
 * Колонки из имени уникального индекса (`LEGACY-400`, пачка `T80`). Тип ошибки адаптера допускает
 * `constraint: { index }` вместо `fields` — так приходит отказ, у которого Postgres не дал текста
 * `Key (...)`. Имя Prisma строит как `<таблица>_<колонка>_<колонка>_key`, и в колонке с `@map`
 * подчёркивание бывает своё (`Page_language_system_key_key`), поэтому имя режется не по `_`, а по
 * настоящим колонкам модели из схемы. Модель не названа, имя не по соглашению или кусок не совпал
 * ни с одной колонкой — пусто, как раньше: вызывающий отвечает общим отказом, а не угадывает причину.
 */
function indexFields(index: string, modelName: string | undefined): string[] {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
  const name = columnName(index);
  if (!model || !name.endsWith('_key')) return [];
  const table = model.dbName ?? model.name;
  const body = name.slice(0, -'_key'.length);
  if (!body.startsWith(`${table}_`)) return [];
  // Длинные имена первыми: `system_key` не должен разобраться как `system` и хвост.
  const columns = model.fields
    .filter((field) => field.kind === 'scalar' || field.kind === 'enum')
    .map((field) => field.dbName ?? field.name)
    .sort((a, b) => b.length - a.length);
  const fields: string[] = [];
  let rest = body.slice(table.length + 1);
  while (rest.length > 0) {
    const column = columns.find((c) => rest === c || rest.startsWith(`${c}_`));
    if (column === undefined) return [];
    fields.push(column);
    rest = rest.slice(column.length + 1);
  }
  return fields;
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

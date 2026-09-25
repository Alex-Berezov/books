import { Prisma } from '@prisma/client';

/**
 * Классы Json-колонок описывают форму тела запроса, а Prisma ждёт `InputJsonValue`.
 * Необязательные поля класса дают `| undefined`, которого в JSON не бывает, поэтому граница
 * между DTO и записью в базу проходит ровно здесь — одним местом, а не кастом на каждом поле.
 *
 * Годится только для **создания**: там нет разницы между «поле не пришло» и «поле стёрто» -
 * колонка без явного значения и так получит SQL `NULL` (у `Json?` нет `@default`). Для **правки**
 * разница есть, и `toJsonInput` её стирает - там нужен {@link jsonField}.
 */
export const toJsonInput = (value: unknown): Prisma.InputJsonValue | undefined =>
  value === undefined || value === null ? undefined : (value as Prisma.InputJsonValue);

/**
 * Три разных входа в `data` на **правке** — три разных итога, и путать их нельзя. Поля нет
 * в правке (`undefined`): колонка не трогается, ключа в `data` не будет вовсе. Пришёл `null`:
 * колонка очищается, и очищается именно `Prisma.DbNull` — тем же SQL `NULL`, что лежит
 * у никогда не заполнявшихся строк, иначе «не заполняли» и «очистили» разойдутся в фильтрах
 * по Json. Голый JS `null` Prisma для `Json?`-колонки не принимает («Invalid value ... Provide
 * `Prisma.DbNull`»), поэтому `toJsonInput` на правке дал бы либо потерянную очистку (превратил бы
 * `null` в `undefined`), либо неотловленный отказ клиента — оба хуже, чем явный сентинел здесь.
 * Пришёл массив: пишется как есть.
 */
export type JsonFieldInput = Prisma.InputJsonValue | typeof Prisma.DbNull;

export const jsonField = <K extends string>(
  key: K,
  value: unknown,
): Partial<Record<K, JsonFieldInput>> => {
  if (value === undefined) return {};
  const written: JsonFieldInput = value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
  return { [key]: written } as Record<K, JsonFieldInput>;
};

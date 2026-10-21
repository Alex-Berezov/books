import { Prisma } from '@prisma/client';

/**
 * Дата процесса для сырого SQL против колонки `TIMESTAMP(3)` без пояса - в UTC явно, как её
 * пишет Prisma на `create`/`update`. Значение не зависит ни от пояса сессии, ни от того, как
 * адаптер передаёт голый `Date` (сейчас `@prisma/adapter-pg` шлёт строку без пояса, и сдвига
 * нет - но это поведение адаптера, а не гарантия; e2e проверяет обёртку под `Europe/Moscow`).
 * Одна копия на репозиторий: разделы пересказа (`movedAt`) и исполнитель LLM (аренда, сроки).
 */
export function utcTimestamp(date: Date): Prisma.Sql {
  return Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

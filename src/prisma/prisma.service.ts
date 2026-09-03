import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Размер пула. Умолчание — оно же было действующим потолком до `LEGACY-237`, пока `max`
 * не задавался вовсе; оставлено ровно таким, чтобы появление настройки не меняло поведение
 * прода само по себе. Из окружения он читается потому, что прод и e2e расходятся здесь
 * на порядок: на проде один процесс и пул может быть широким, в e2e каждый набор поднимает
 * свой `AppModule` со своим пулом, и при нескольких воркерах их суммарно выходит больше
 * `max_connections` Postgres.
 *
 * 🔴 До `LEGACY-237` потолок объявлялся параметром `connection_limit` в строке
 * подключения. Это параметр **движка Prisma**, а клиент здесь собран на
 * драйверном адаптере: пул создаёт `pg`, и строку подключения он читает только
 * ради адреса и учётных данных. То есть объявленного потолка не существовало,
 * а комментарии в конвейере называли его настроенным.
 */
const DEFAULT_POOL_MAX = 10;

/**
 * Ожидание соединения. Умолчание `pg` — `connectionTimeoutMillis: 0`, то есть ждать
 * бесконечно. С единственным пулом на всё приложение (`LEGACY-130`) это значит, что
 * `max`+1-й одновременный запрос висит, пока кто-нибудь не отпустит, а вместе с ним висит
 * и проба готовности: `readiness` ходит тем же клиентом и очередь делит с трафиком.
 *
 * Пятнадцать секунд, а не пять: четыре места объявляют `maxWait: 10_000` для интерактивной
 * транзакции (`grep -rn "maxWait: 10_000" src/` — `contributors.service.ts`,
 * `persons.service.ts`, `category-tree.service.ts`, `tags/tag-lock.service.ts`),
 * и при меньшем потолке `pg` обрывал бы получение соединения раньше, чем Prisma начнёт
 * ждать слот, — объявленный бюджет стал бы недостижим, а в логе вместо `P2028` лежала бы
 * ошибка драйвера. Десять ровно дали бы неопределённый порядок двух таймаутов; запас
 * покрывает ещё и установление соединения (рукопожатие и аутентификацию) на пустом пуле.
 */
const DEFAULT_POOL_TIMEOUT_MS = 15000;

/**
 * Разбор числовой настройки пула: годится только целое больше нуля, всё остальное —
 * отсутствие, пустая строка, мусор, ноль и отрицательное — даёт умолчание. Один разбор
 * на обе настройки: две копии одного правила разошлись бы при первой же правке, и одна
 * настройка стала бы читаться иначе, чем соседняя.
 *
 * Принимает **значение**, а не имя ключа: `process.env[key]` внутри хелпера прячет имя
 * от `scripts/check-env.mjs` — сканер такое чтение не разбирает и останавливает проверку.
 */
const positiveIntOr = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private pool: Pool;

  /** Закрытие уже прошло: см. `onModuleDestroy`, там же причина. */
  private closed = false;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    const pool = new Pool({
      connectionString,
      max: positiveIntOr(process.env.DATABASE_POOL_MAX, DEFAULT_POOL_MAX),
      connectionTimeoutMillis: positiveIntOr(
        process.env.DATABASE_POOL_TIMEOUT_MS,
        DEFAULT_POOL_TIMEOUT_MS,
      ),
    });
    const adapter = new PrismaPg(pool);
    super({ adapter, log: ['info', 'warn', 'error'] });
    this.pool = pool;
  }

  async onModuleInit() {
    // Skip DB connection for OpenAPI docs generation in dev mode
    if (process.env.SKIP_DB_CONNECT === '1') {
      console.log('[PrismaService] Skipping database connection (SKIP_DB_CONNECT=1)');
      return;
    }
    await this.$connect();
  }

  /**
   * 🔴 `LEGACY-364`. Закрытие идемпотентно: `pg.Pool.end()` при втором вызове
   * отвергает промис («Called end on pool more than once»), а закрыть сервис
   * дважды законно — контейнер Nest в тестах закрывают и явно, и повторно
   * через `TestingModule.close()`.
   *
   * ⚠️ Флаг ставится **до** ожидания, а не после: два параллельных закрытия
   * иначе оба прошли бы проверку и оба дошли бы до `pool.end()`.
   *
   * ⚠️ `pool.end()` стоит в `finally`: отказ `$disconnect()` иначе оставлял бы
   * пул открытым навсегда — повторный вызов вышел бы по флагу молча, и в e2e
   * при двух воркерах это тот самый «sorry, too many clients already».
   */
  async onModuleDestroy() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.$disconnect();
    } finally {
      await this.pool.end();
    }
  }
}

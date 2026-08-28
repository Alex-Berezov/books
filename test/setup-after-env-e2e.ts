import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Выполняется **внутри каждого воркера** — здесь происходит развод по базам.
 *
 * 🔴 Раскладка читается из файла, а не из переменных окружения: `globalSetup`
 * идёт отдельным процессом, и его `process.env` воркерам не наследуется. Первая
 * версия полагалась на переменные — подмены не происходило, все воркеры сидели
 * на одной базе, и прогон это почти не показал: данные в тестах уникальны по
 * времени, упали только три места с общей сущностью (`admin@example.com`).
 *
 * ⚠️ Подмена обязана случиться до того, как тест поднимет приложение:
 * `PrismaService` читает `DATABASE_URL` при инициализации модуля.
 */
const HANDOFF_FILE = path.join(os.tmpdir(), 'books-e2e-databases.json');

try {
  const raw = fs.readFileSync(HANDOFF_FILE, 'utf-8');
  const { baseUrl, prefix, workers } = JSON.parse(raw) as {
    baseUrl: string;
    prefix: string;
    workers: number;
  };
  const workerId = Number(process.env.JEST_WORKER_ID || '1');
  // Воркеров у Jest может оказаться больше, чем баз (например, при ручном
  // `--maxWorkers`): раскладываем по кругу, чтобы никто не остался без базы.
  const index = ((workerId - 1) % Math.max(1, workers)) + 1;

  const url = new URL(baseUrl);
  url.pathname = `/${prefix}${index}`;
  url.searchParams.delete('schema');

  process.env.DATABASE_URL = url.toString();

  // 🔴 Без потолка на пул параллельный прогон упирается в `max_connections`
  // Postgres: каждый набор поднимает `AppModule` со своим пулом, и при
  // нескольких воркерах их суммарно выходит больше сотни. Падает при этом не
  // тест, а случайный запрос внутри него — «sorry, too many clients already», —
  // и выглядит это как сломанный код, а не как исчерпанный ресурс.
  //
  // ⚠️ До `LEGACY-237` потолок писался как `connection_limit` в строку
  // подключения и **не действовал**: это параметр движка Prisma, а пул здесь
  // создаёт `pg` — он читает строку только ради адреса. Настоящий потолок
  // задаётся `max` у пула, и `PrismaService` берёт его отсюда.
  process.env.DATABASE_POOL_MAX = process.env.E2E_CONNECTION_LIMIT || '5';
} catch (error) {
  throw new Error(
    `e2e: не удалось прочитать раскладку баз (${HANDOFF_FILE}). ` +
      'Без неё воркеры работают с одной базой и портят данные друг другу. ' +
      String(error),
  );
}

afterAll(() => {
  if (typeof global.gc === 'function') {
    global.gc();
  }
});

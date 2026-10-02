import { Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Стенд живых проб замков (`LEGACY-400`, `LEGACY-433`): чьё соединение держит транзакцию
 * и встал ли кто-то в очередь именно за ним. Без второго зелёная проба ничего не значит —
 * вторая сторона могла проскочить мимо замка.
 */
export const backendPid = async (tx: Prisma.TransactionClient): Promise<number> => {
  const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
  return row.pid;
};

/**
 * Ждёт, пока кто-то встанет в очередь именно за соединением `holderPid`. Опрос до дедлайна,
 * а не один замер после паузы: на медленной машине вторая сторона доезжает до замка не сразу.
 */
export const waitBlockedBy = async (
  client: PrismaService,
  holderPid: number,
  deadlineMs = 10_000,
): Promise<boolean> => {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const [row] = await client.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
    if (row.n > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

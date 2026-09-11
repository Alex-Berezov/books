import { readFileSync } from 'fs';
import { SRC_ROOT, listFiles, relativeToSrc } from './controller-decorators';

/**
 * Сторож перечня мест записи в `AdminAuditEvent` (`LEGACY-015`).
 *
 * Журнал административных действий ценен ровно настолько, насколько одинаково его пишут.
 * Запись, ушедшая мимо транзакции своей операции, переживает её откат и утверждает действие,
 * которого не было (`LEGACY-036`); запись со своей формой `payload` ломает выборку по журналу
 * молча. Оба отказа не видны ни компилятору, ни ревью соседнего модуля.
 *
 * ⚠️ Проверка спеки на конкретный метод такой гарантии не даёт: она молчит про метод, который
 * допишут завтра. Поэтому здесь заморожен **перечень мест**, а не поведение: любая новая запись
 * в `AdminAuditEvent` — где угодно в `src` — роняет эту спеку и требует решения.
 *
 * ⚠️ Тип `Prisma.TransactionClient` — это `Omit<PrismaClient, ITXClientDenyList>`, и корневой
 * `PrismaService` ему структурно подходит. Значит «писать только через `tx`» компилятором
 * не держится вовсе, и держать это может либо посадка на каждом пути, либо вот такой перечень.
 *
 * ⚠️ Обход дерева берётся из `controller-decorators.ts`, а не пишется заново: рукописных копий
 * `readdirSync` в репозитории и так больше, чем нужно, и расходятся они молча (`LEGACY-290`).
 */

const WRITE_OPS = 'create|createMany|upsert|update|updateMany|delete|deleteMany';
const WRITE_RE = new RegExp(`adminAuditEvent\\.(?:${WRITE_OPS})\\b`, 'g');

/** Клиент, на котором сделана запись: `tx.` — транзакционный, что угодно ещё — корневой. */
const TX_RE = new RegExp(`tx\\.adminAuditEvent\\.(?:${WRITE_OPS})\\b`, 'g');

type Site = { file: string; op: string };

/**
 * Замороженный перечень. `via: 'tx'` — запись идёт клиентом транзакции;
 * запись через корневой клиент в перечне не разрешена вовсе и должна отсутствовать.
 */
const EXPECTED: Array<Site & { count: number; via: 'tx'; why: string }> = [
  {
    file: 'modules/users/users.service.ts',
    op: 'createMany',
    count: 1,
    via: 'tx',
    why: 'единственный писатель — приватный recordRoleAuditEvents, зовётся с четырёх путей смены ролей',
  },
];

describe('места записи в AdminAuditEvent заморожены (LEGACY-015)', () => {
  const found = new Map<string, number>();
  const viaRootClient: string[] = [];

  beforeAll(() => {
    const sources = listFiles(
      SRC_ROOT,
      (path) => path.endsWith('.ts') && !path.endsWith('.spec.ts'),
    );

    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      const rel = relativeToSrc(file);

      const writes = text.match(WRITE_RE) ?? [];
      for (const write of writes) {
        const op = write.split('.').pop() as string;
        const key = `${rel}::${op}`;
        found.set(key, (found.get(key) ?? 0) + 1);
      }

      // Записей столько же, сколько обращений через `tx.`? Если нет — часть ушла
      // на корневой клиент и переживёт откат своей операции.
      const viaTx = (text.match(TX_RE) ?? []).length;
      if (writes.length > viaTx) {
        viaRootClient.push(`${rel}: ${writes.length - viaTx} запись(ей) мимо клиента транзакции`);
      }
    }
  });

  it('перечень мест записи совпадает с замороженным', () => {
    const actual = Object.fromEntries([...found.entries()].sort());
    const expected = Object.fromEntries(
      EXPECTED.map(({ file, op, count }) => [`${file}::${op}`, count] as const).sort(),
    );

    // Появилось новое место — прочитай доккомментарий выше и реши: новый писатель
    // обязан идти через общий хелпер, а не копировать `adminAuditEvent.createMany`.
    expect(actual).toEqual(expected);
  });

  it('ни одна запись не идёт мимо клиента транзакции', () => {
    expect(viaRootClient).toEqual([]);
  });

  it('у каждой записи перечня названа причина', () => {
    for (const site of EXPECTED) {
      expect(site.why.length).toBeGreaterThan(20);
      expect(site.via).toBe('tx');
    }
  });
});

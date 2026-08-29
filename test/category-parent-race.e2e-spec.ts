import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { CategoryService } from '../src/modules/category/category.service';
import { CategoryTreeService } from '../src/modules/category/category-tree.service';

/**
 * 🔴 `LEGACY-274`. Гонка двух одновременных `PATCH A {parent: B}` и
 * `PATCH B {parent: A}` замыкала дерево категорий: `LEGACY-266` вернул
 * инвариант «проверка ходит клиентом записи», но при `read committed` каждый
 * оператор внутри транзакции берёт свежий снимок и чужих незакоммиченных строк
 * не видит, а голые `SELECT` подъёма никого не блокируют. Обе транзакции
 * проходили проверку, обе коммитились.
 *
 * ⚠️ Эта посадка живёт в e2e, а не в юнитах, намеренно: мок `$transaction`
 * гонку не воспроизводит вовсе — он исполняет тело последовательно. Блокировку
 * можно доказать только настоящим Postgres, где вторая транзакция физически
 * ждёт первую.
 */
describe('Смена родителя категории под гонкой (LEGACY-274)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let categories: CategoryService;
  let tree: CategoryTreeService;

  const TX = { timeout: 30_000, maxWait: 15_000 } as const;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    categories = moduleRef.get(CategoryService);
    tree = moduleRef.get(CategoryTreeService);
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    // База воркера переживает прогон, а спека заводит по две категории на пару:
    // без уборки она растёт от запуска к запуску.
    await prisma.category.deleteMany({ where: { key: { startsWith: 'race-' } } });
    await app?.close();
  });

  const makePair = async (tag: string) => {
    const a = await prisma.category.create({
      data: { type: 'genre', name: `A ${tag}`, slug: `race-a-${tag}`, key: `race-a-${tag}` },
    });
    const b = await prisma.category.create({
      data: { type: 'genre', name: `B ${tag}`, slug: `race-b-${tag}`, key: `race-b-${tag}` },
    });
    return { a, b };
  };

  /**
   * Прямое доказательство самой блокировки: пока первая транзакция её держит,
   * вторая до своего тела не доходит. Проверяется именно ожидание, а не факт
   * вызова — `pg_advisory_lock` вместо `pg_advisory_xact_lock` или вызов
   * на клиенте пула прошли бы проверку «функция вызвана» и не стерегли бы
   * ничего.
   */
  it('вторая транзакция ждёт, пока первая держит блокировку дерева', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let secondEntered = false;

    const first = prisma.$transaction(async (tx) => {
      await tree.lockTree(tx);
      await held;
    }, TX);

    // Даём первой транзакции взять блокировку до старта второй.
    await sleep(500);

    const second = prisma.$transaction(async (tx) => {
      await tree.lockTree(tx);
      secondEntered = true;
    }, TX);

    try {
      await sleep(1000);
      expect(secondEntered).toBe(false);
    } finally {
      // ⚠️ `finally` обязателен: упавший ассерт оставил бы первую транзакцию
      // открытой с блокировкой до её таймаута, а обе транзакции отверглись бы
      // уже после конца теста — unhandled rejection поверх настоящей причины.
      release();
    }

    await first;
    await second;
    expect(secondEntered).toBe(true);
  });

  /**
   * Продуктовая сторона того же: два встречных PATCH, поданных одновременно.
   * Ожидание — ровно один успех, второй отказывает по циклу, и в базе
   * не остаётся замкнутой пары.
   *
   * ⚠️ Пар несколько: одиночная попытка на снятой блокировке разошлась бы
   * не каждый раз, и красное было бы плавающим.
   */
  it('встречные PATCH не замыкают дерево: побеждает ровно один', async () => {
    const PAIRS = 12;

    for (let i = 0; i < PAIRS; i += 1) {
      const tag = `${Date.now()}-${i}`;
      const { a, b } = await makePair(tag);

      const results = await Promise.allSettled([
        categories.update(a.id, { parentId: b.id }),
        categories.update(b.id, { parentId: a.id }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);

      const [rowA, rowB] = await Promise.all([
        prisma.category.findUnique({ where: { id: a.id }, select: { parentId: true } }),
        prisma.category.findUnique({ where: { id: b.id }, select: { parentId: true } }),
      ]);
      // Замкнутая пара — это когда каждый указывает на другого.
      expect(rowA?.parentId === b.id && rowB?.parentId === a.id).toBe(false);
    }
  }, 120_000);
});

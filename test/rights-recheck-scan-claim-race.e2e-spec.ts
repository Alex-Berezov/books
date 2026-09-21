import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { BackgroundJobsRegistry } from '../src/modules/background-jobs/background-jobs.registry';
import { RightsRecheckSchedulerService } from '../src/modules/rights-recheck/rights-recheck-scheduler.service';
import { RightsRecheckService } from '../src/modules/rights-recheck/rights-recheck.service';
import { RightsNotificationsService } from '../src/modules/rights-agent/rights-notifications.service';
import { RightsRecheckTriggerSource } from '../src/modules/rights-recheck/rights-recheck-interface';

/**
 * 🔴 `LEGACY-021`. Скан перепроверок защищался от параллельных прогонов только флагом
 * `isRunning` в памяти процесса: при двух инстансах бэкенда каждый видел собственный `false`,
 * и оба стартовали скан одновременно. `runScan` теперь занимает слот под
 * `pg_advisory_xact_lock` (`claimRun`/`lockScan`).
 *
 * ⚠️ Эта посадка живёт в e2e, а не в юнитах, намеренно — по прецеденту `LEGACY-274`
 * (`test/category-parent-race.e2e-spec.ts`): мок `$transaction` гонку не воспроизводит вовсе,
 * он исполняет тело последовательно, а мок `$queryRaw` вернёт «замок взят» на любой вход,
 * включая опечатку в SQL и сессионный `pg_advisory_lock` вместо транзакционного. Блокировку
 * можно доказать только настоящим Postgres, где вторая сторона физически ждёт первую.
 */
describe('Claim скана перепроверок под гонкой (LEGACY-021)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let scheduler: RightsRecheckSchedulerService;
  let secondInstance: RightsRecheckSchedulerService;

  /**
   * Значение продублировано намеренно: ключ объявлен файл-локально в самом сервисе
   * (как `CATEGORY_TREE_LOCK_KEY` в `category-tree.service.ts:52`) и наружу не выставлен.
   * Разъедется — первый тест это и покажет: удерживаемый здесь замок перестанет задерживать
   * claim, и ожидание «вторая сторона ждёт» не сбудется.
   */
  const RECHECK_SCAN_LOCK_KEY = 8_314_270_002n;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const runningRows = () => prisma.rightsRecheckScanRun.count({ where: { status: 'RUNNING' } });
  const allRows = () => prisma.rightsRecheckScanRun.count();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    scheduler = moduleRef.get(RightsRecheckSchedulerService);

    // Второй инстанс сервиса с теми же зависимостями — это и есть второй контейнер:
    // у него собственный `isRunning`, и договориться с первым он может только через базу.
    secondInstance = new RightsRecheckSchedulerService(
      prisma,
      moduleRef.get(RightsRecheckService),
      moduleRef.get(RightsNotificationsService),
      moduleRef.get(ConfigService),
      new BackgroundJobsRegistry(),
    );

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await prisma.rightsRecheckScanRun.deleteMany({});
    await app?.close();
  });

  beforeEach(async () => {
    await prisma.rightsRecheckScanRun.deleteMany({});
  });

  /**
   * Прямое доказательство самой блокировки: пока чужая транзакция держит тот же ключ,
   * claim до своего тела не доходит. Проверяется именно ожидание, а не факт вызова —
   * сессионный `pg_advisory_lock`, вызов на клиенте пула или другой ключ прошли бы проверку
   * «функция вызвана» и не стерегли бы ничего.
   */
  it('claim ждёт, пока чужая транзакция держит тот же advisory-ключ', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT true AS locked FROM pg_advisory_xact_lock(${RECHECK_SCAN_LOCK_KEY})`;
        await held;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );

    // Даём удерживающей транзакции взять замок до старта скана.
    await sleep(500);

    let scanSettled = false;
    const scan = scheduler.runScan(RightsRecheckTriggerSource.MANUAL, null).finally(() => {
      scanSettled = true;
    });

    try {
      await sleep(1500);
      // Замок держат — claim не прошёл, строки прогона в базе нет.
      expect(scanSettled).toBe(false);
      expect(await allRows()).toBe(0);
    } finally {
      // `finally` обязателен: упавший ассерт оставил бы удерживающую транзакцию открытой
      // до её таймаута, а обе отверглись бы уже после конца теста.
      release();
    }

    await holder;
    await scan;
    // Замок отпущен — claim прошёл, прогон состоялся и закрылся.
    expect(scanSettled).toBe(true);
    expect(await allRows()).toBe(1);
    expect(await runningRows()).toBe(0);
  }, 60_000);

  /**
   * Продуктовая сторона того же: два инстанса стартуют скан одновременно. Ожидание —
   * ровно один занимает слот, второй отказывает с 409, и в базе ровно одна строка прогона.
   *
   * ⚠️ Пар несколько: без замка расхождение зависит от того, как лягут обращения к базе,
   * и одиночная попытка давала бы плавающее красное.
   */
  it('два инстанса одновременно: слот занимает ровно один', async () => {
    const PAIRS = 3;

    for (let i = 0; i < PAIRS; i += 1) {
      await prisma.rightsRecheckScanRun.deleteMany({});

      const results = await Promise.allSettled([
        scheduler.runScan(RightsRecheckTriggerSource.MANUAL, null),
        secondInstance.runScan(RightsRecheckTriggerSource.MANUAL, null),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({
        response: { code: 'RECHECK_SCAN_ALREADY_RUNNING', statusCode: 409 },
      });

      // Проигравший не завёл собственной строки прогона — иначе сканов было бы два.
      expect(await allRows()).toBe(1);
      expect(await runningRows()).toBe(0);
    }
  }, 120_000);

  /**
   * Автоматический прогон второго инстанса не отказывает, а тихо отдаёт чужой прогон —
   * и тоже не заводит второй строки.
   */
  it('автоматический прогон второго инстанса не заводит вторую строку', async () => {
    const results = await Promise.allSettled([
      scheduler.runScan(RightsRecheckTriggerSource.SCHEDULER, null),
      secondInstance.runScan(RightsRecheckTriggerSource.SCHEDULER, null),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await allRows()).toBe(1);
    expect(await runningRows()).toBe(0);
  }, 60_000);
});

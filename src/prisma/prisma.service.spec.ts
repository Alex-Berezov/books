import { PrismaService } from './prisma.service';

/**
 * `options` у `pg.Pool` существует, но в типах пакета не объявлен. Читать
 * приходится его, а не строку подключения: смысл проверки в том, что до
 * драйвера дошло именно число.
 */
type ProbedPool = {
  options: { max?: number; connectionTimeoutMillis?: number };
  end: () => Promise<void>;
};

/**
 * Пул сервиса — поле приватное, и добраться до него можно только приведением,
 * то есть с выключенной проверкой типов. Поэтому доступ здесь **один на файл**:
 * переименование поля компилятор не поймает ни в одной копии, и пропущенная
 * копия покраснела бы в чужом блоке, а не в том, который сломали.
 */
const poolOf = (service: PrismaService): ProbedPool =>
  (service as unknown as { pool: ProbedPool }).pool;

/**
 * `LEGACY-237`. Потолок на пул объявлялся параметром `connection_limit`
 * в строке подключения и не действовал: это параметр движка Prisma, а клиент
 * собран на драйверном адаптере — пул создаёт `pg`, и строку подключения он
 * читает только ради адреса и учётных данных. Размер брался из умолчания `pg`
 * (10) и нигде не задавался, при том что комментарии в двух конвейерах
 * называли настроенным потолком пятёрку на воркер.
 *
 * Цена мёртвого ограничителя не в самом числе, а в том, что попытка ускорить
 * прогон подъёмом `--maxWorkers` упирается в `max_connections=100` у
 * `postgres:14` и падает не тестом, а случайным запросом внутри теста
 * («sorry, too many clients already»), — и тот, кто читал комментарии, будет
 * искать причину где угодно, кроме размера пула.
 *
 * ⚠️ Проверка смотрит на то, что получил `pg`, а не на текст строки
 * подключения. Ровно этой разницей дефект и держался: в строке было
 * написано всё правильно, читать её было некому.
 */
describe('LEGACY-237 — размер пула задан и приходит из окружения', () => {
  let service: PrismaService | undefined;
  const savedMax = process.env.DATABASE_POOL_MAX;
  const savedUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/pool_probe';
  });

  // Конструктор делает `new Pool`, поэтому закрытие стоит в `afterEach`, а не
  // последней строкой кейса: при упавшем `expect` до неё не дойдёт, и jest
  // поверх красного прогона повиснет на незакрытом пуле до таймаута.
  afterEach(async () => {
    if (service) await poolOf(service).end();
    service = undefined;
    if (savedMax === undefined) delete process.env.DATABASE_POOL_MAX;
    else process.env.DATABASE_POOL_MAX = savedMax;
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
  });

  it('берёт потолок из DATABASE_POOL_MAX', () => {
    process.env.DATABASE_POOL_MAX = '3';
    service = new PrismaService();
    expect(poolOf(service).options.max).toBe(3);
  });

  it('без переменной держит умолчание pg, а не «сколько угодно»', () => {
    delete process.env.DATABASE_POOL_MAX;
    service = new PrismaService();
    expect(poolOf(service).options.max).toBe(10);
  });

  it('мусор в переменной не снимает потолок', () => {
    process.env.DATABASE_POOL_MAX = 'много';
    service = new PrismaService();
    expect(poolOf(service).options.max).toBe(10);
  });

  it('ноль и отрицательное значение потолок не снимают', () => {
    process.env.DATABASE_POOL_MAX = '0';
    service = new PrismaService();
    expect(poolOf(service).options.max).toBe(10);
  });
});

/**
 * `LEGACY-256`. Пул создавался без `connectionTimeoutMillis`, то есть с умолчанием `pg` — ноль,
 * «ждать бесконечно». После сведения всех клиентов к одному (`LEGACY-130`) это значит, что
 * `max`+1-й одновременный запрос висит до тех пор, пока соединение не отпустят, и проба
 * готовности висит вместе с ним: `HealthService.readiness` ходит тем же клиентом и стоит
 * в той же очереди. Наружу это выглядит как пропавший `/health`, а не как отказ базы.
 *
 * Умолчание — 15 секунд, решением арбитра от 01.09.2026: несколько мест объявляют
 * `maxWait: 10_000` для интерактивной транзакции (`grep -rn "maxWait: 10_000" src/` —
 * на 03.09.2026 их четыре), и меньший потолок делал бы этот бюджет недостижимым.
 *
 * ⚠️ Проверяется то, что дошло до `pg`, а не наличие переменной в окружении: смысл записи
 * в том, чтобы у пула был конечный потолок ожидания при любом значении переменной.
 */
describe('LEGACY-256 — ожидание свободного соединения конечно', () => {
  let service: PrismaService | undefined;
  const savedTimeout = process.env.DATABASE_POOL_TIMEOUT_MS;
  const savedUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/pool_probe';
  });

  afterEach(async () => {
    if (service) await poolOf(service).end();
    service = undefined;
    if (savedTimeout === undefined) delete process.env.DATABASE_POOL_TIMEOUT_MS;
    else process.env.DATABASE_POOL_TIMEOUT_MS = savedTimeout;
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
  });

  it('берёт ожидание из DATABASE_POOL_TIMEOUT_MS', () => {
    process.env.DATABASE_POOL_TIMEOUT_MS = '1500';
    service = new PrismaService();
    expect(poolOf(service).options.connectionTimeoutMillis).toBe(1500);
  });

  it('без переменной ждёт пятнадцать секунд, а не бесконечно', () => {
    delete process.env.DATABASE_POOL_TIMEOUT_MS;
    service = new PrismaService();
    expect(poolOf(service).options.connectionTimeoutMillis).toBe(15000);
  });

  it('мусор в переменной не возвращает бесконечное ожидание', () => {
    process.env.DATABASE_POOL_TIMEOUT_MS = 'подольше';
    service = new PrismaService();
    expect(poolOf(service).options.connectionTimeoutMillis).toBe(15000);
  });

  it('ноль не считается «ждать сколько угодно»', () => {
    process.env.DATABASE_POOL_TIMEOUT_MS = '0';
    service = new PrismaService();
    expect(poolOf(service).options.connectionTimeoutMillis).toBe(15000);
  });
});

/**
 * 🔴 `LEGACY-364`. Сервис закрывают дважды: явным `close()` контейнера и
 * повторным вызовом того же хука. Без флага второй вызов отвергает промис `pg`
 * («Called end on pool more than once»), и набор краснел бы по этой ошибке.
 */
describe('LEGACY-364 — закрытие пула идемпотентно', () => {
  const savedUrl = process.env.DATABASE_URL;

  let service: PrismaService | undefined;

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/pool_probe';
  });

  // Пул закрывается здесь, а не в теле кейса: упавший `expect` до закрытия
  // не доходит, и jest поверх красного прогона повис бы на живом дескрипторе.
  afterEach(async () => {
    // Пул мог быть уже закрыт самим кейсом — второй `end()` у `pg` отвергает промис.
    if (service)
      await poolOf(service)
        .end()
        .catch(() => undefined);
    service = undefined;
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
  });

  it('второй вызов onModuleDestroy не бросает и не трогает пул заново', async () => {
    service = new PrismaService();
    const end = jest.spyOn(poolOf(service), 'end');
    // `$disconnect` ходит в базу, которой в юнит-прогоне нет: проверяется
    // порядок закрытия, а не соединение.
    const disconnect = jest
      .spyOn(service, '$disconnect')
      .mockResolvedValue(undefined as unknown as void);

    await service.onModuleDestroy();
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();

    expect(end).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠️ Именно этот кейс держит порядок «флаг до ожидания». Перенос
   * `this.closed = true` под `await` последовательный кейс выше не краснит:
   * первый вызов там успевает закрыть пул раньше второго.
   */
  it('два одновременных закрытия дают ровно одно закрытие пула', async () => {
    service = new PrismaService();
    const end = jest.spyOn(poolOf(service), 'end');
    jest.spyOn(service, '$disconnect').mockResolvedValue(undefined as unknown as void);

    await Promise.all([service.onModuleDestroy(), service.onModuleDestroy()]);

    expect(end).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠️ Отказ `$disconnect()` не должен оставлять пул открытым: повторный вызов
   * вышел бы по флагу молча, и соединения жили бы до смерти процесса — при двух
   * воркерах e2e это «sorry, too many clients already».
   */
  it('пул закрывается даже при отказе $disconnect', async () => {
    service = new PrismaService();
    const end = jest.spyOn(poolOf(service), 'end');
    jest.spyOn(service, '$disconnect').mockRejectedValue(new Error('связь потеряна'));

    await expect(service.onModuleDestroy()).rejects.toThrow('связь потеряна');

    expect(end).toHaveBeenCalledTimes(1);
  });
});

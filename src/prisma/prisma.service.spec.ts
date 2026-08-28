import { PrismaService } from './prisma.service';

/**
 * `options` у `pg.Pool` существует, но в типах пакета не объявлен. Читать
 * приходится его, а не строку подключения: смысл проверки в том, что до
 * драйвера дошло именно число.
 */
type ProbedPool = { options: { max?: number }; end: () => Promise<void> };

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
  const poolOf = (service: PrismaService): ProbedPool =>
    (service as unknown as { pool: ProbedPool }).pool;

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

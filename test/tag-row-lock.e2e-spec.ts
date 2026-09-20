import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TagsService } from '../src/modules/tags/tags.service';
import { TagLockService } from '../src/modules/tags/tag-lock.service';
import { ImportService } from '../src/modules/import/import.service';

/**
 * 🔴 `LEGACY-320`. Импорт тега читал строку внутри транзакции и решал по ней три
 * вещи — писать ли историю базового слага, создавать перевод или обновлять, есть
 * ли термин вообще, — а админский `PATCH /tags/:id` читал свою строку вовсе
 * на клиенте пула. Между чтением и записью помещалась чужая транзакция: редирект
 * уходил со слага, которого в базе уже нет, а в отчёте стояло `updated: 1`
 * и пустые `errors`.
 *
 * ⚠️ Юнит этого не воспроизводит и воспроизвести не может: поддельный
 * `$transaction` в `import.service.spec.ts` исполняет колбэк синхронно, то есть
 * двух одновременных транзакций там не существует. Нужен живой Postgres —
 * образец рядом, `category-parent-race.e2e-spec.ts`.
 *
 * ⚠️ Замок берётся продуктовой точкой входа `runInLockedTag`, а не своим
 * `SELECT ... FOR UPDATE` в спеке: проверяется поведение, которое получит
 * админка и импорт, а не то, что умеет Postgres.
 */
describe('LEGACY-320 — строка тега запирается на путях, где снимок решает (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let tags: TagsService;
  let tagLock: TagLockService;
  let imports: ImportService;

  const stamp = Date.now();
  const prefix = `lock-${stamp}`;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * ⚠️ HTTP-приложение здесь **не поднимается**: спека ходит в сервисы напрямую,
   * ни одного запроса через supertest в ней нет. `moduleRef.init()` запускает те же
   * `onModuleInit` и `onApplicationBootstrap`, что и `app.init()` (без первого
   * `PrismaService` не подключается), но не создаёт объект сервера и не регистрирует
   * маршруты, гварды и middleware.
   *
   * ⚠️ Экономия ограничена **слоем маршрутизации**, и это не «набор больше
   * не поднимает AppModule»: `compile()` по-прежнему создаёт все провайдеры,
   * а это и есть основная часть тех самых секунд на набор из комментария
   * к `maxWorkers` в `test/jest-e2e.json`. Сколько именно снимает отказ
   * от HTTP-слоя, здесь не измерялось.
   *
   * ⚠️ Порядок обязателен: сервисы достаются **до** `init()`. Отказ любого
   * `onModuleInit` (недоступный Redis у очередей, планировщики) иначе оставил бы
   * `prisma` неприсвоенным, `afterAll` упал бы на нём первой же строкой,
   * и `moduleRef.close()` не позвался бы вовсе — соединения этого набора висели бы
   * до конца прогона. На выкате наборы идут двумя воркерами
   * (`deploy.yml:319` — `--maxWorkers=2`), у каждого свой пул и своя база,
   * и лишний висящий пул упирает прогон в `max_connections` (`LEGACY-237`).
   */
  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    tags = moduleRef.get(TagsService);
    tagLock = moduleRef.get(TagLockService);
    imports = moduleRef.get(ImportService);

    await moduleRef.init();
  });

  /**
   * ⚠️ Уборка в `try/finally`: её отказ не должен съедать `close()`. Незакрытый
   * пул виден не как красный тест, а как `sorry, too many clients already`
   * в случайном соседнем наборе.
   */
  afterAll(async () => {
    try {
      await prisma?.tagTranslation.deleteMany({
        where: { tag: { key: { startsWith: prefix } } },
      });
      await prisma?.seo.deleteMany({ where: { metaTitle: { startsWith: prefix } } });
      await prisma?.tag.deleteMany({ where: { key: { startsWith: prefix } } });
    } finally {
      await moduleRef?.close();
    }
  });

  const makeTag = async (suffix: string) =>
    prisma.tag.create({
      data: {
        name: `Lock ${suffix}`,
        slug: `${prefix}-${suffix}`,
        key: `${prefix}-${suffix}`,
      },
    });

  it('админская правка ждёт, пока строку держит чужая транзакция', async () => {
    const tag = await makeTag('held');

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Первая транзакция входит через продуктовую точку и держит строку.
    const first = tagLock.runInLockedTag({ key: tag.key }, async () => {
      await held;
    });

    await sleep(500);

    let secondFinished = false;
    const second = tags
      .update(tag.id, { name: 'Renamed under lock' })
      .then(() => {
        secondFinished = true;
      })
      .catch(() => {
        // Отказ тоже считается завершением: ниже проверяется именно то,
        // что до снятия замка не произошло ничего.
        secondFinished = true;
      });

    try {
      await sleep(1000);
      // 🔴 Суть проверки. До правки `TagsService.update` читал строку на пуле
      // и решал по ней **до** всякой транзакции, поэтому ждать ему было не на
      // чем: он успевал закончить, пока чужая транзакция ещё открыта.
      expect(secondFinished).toBe(false);
    } finally {
      release();
    }

    await first;
    await second;
    expect(secondFinished).toBe(true);

    const after = await prisma.tag.findUnique({ where: { id: tag.id } });
    expect(after?.name).toBe('Renamed under lock');
  }, 120_000);

  it('замок на одном теге не задерживает правку другого', async () => {
    const held = await makeTag('busy');
    const free = await makeTag('free');

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = tagLock.runInLockedTag({ key: held.key }, async () => {
      await gate;
    });

    try {
      await sleep(300);
      // 🔴 Ради этого и выбран замок строки, а не рекомендательный замок
      // на весь класс тегов: общая очередь поставила бы админскую правку
      // любого тега за партией импорта целиком (решение арбитра 03.09.2026).
      await expect(tags.update(free.id, { name: 'Untouched by the lock' })).resolves.toMatchObject({
        name: 'Untouched by the lock',
      });
    } finally {
      release();
    }

    await first;
  }, 120_000);

  it('импорт того же ключа ждёт снятия замка, а не пишет по устаревшему снимку', async () => {
    const tag = await makeTag('import');

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = tagLock.runInLockedTag({ key: tag.key }, async () => {
      await gate;
    });

    await sleep(500);

    let importFinished = false;
    const second = imports
      .importTags([
        {
          key: tag.key,
          name: 'Imported under lock',
          slug: `${prefix}-import-new`,
          translations: { en: { name: 'Imported under lock', slug: `${prefix}-import-en` } },
        },
      ])
      .then(() => {
        importFinished = true;
      });

    try {
      await sleep(1000);
      expect(importFinished).toBe(false);
    } finally {
      release();
    }

    await first;
    await second;
    expect(importFinished).toBe(true);

    // Смена базового слага настоящая, значит история обязана быть записана
    // тем же клиентом, что и сама смена.
    const after = await prisma.tag.findUnique({ where: { key: tag.key } });
    expect(after?.slug).toBe(`${prefix}-import-new`);
  }, 120_000);

  /**
   * Держит замок `target`, пока не вызван `release`, и проверяет, что `write`
   * до этого не закончился — ни успехом, ни отказом. `inside` исполняется
   * держателем уже после `release`, но до коммита.
   */
  const expectWaitsForLock = async (
    target: { key: string } | { id: string },
    write: () => Promise<unknown>,
    inside?: (
      tx: Parameters<Parameters<TagLockService['runInLockedTag']>[1]>[0],
    ) => Promise<unknown>,
    whileHeld?: () => Promise<void>,
  ) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = tagLock.runInLockedTag(target, async (tx) => {
      await gate;
      if (inside) await inside(tx);
    });

    await sleep(500);

    let finished = false;
    const second = write().finally(() => {
      finished = true;
    });
    // Упавшая проверка ниже бросает раньше, чем кто-то дождётся `second`:
    // без обработчика его отказ всплыл бы необработанным в соседнем тесте.
    second.catch(() => undefined);

    try {
      await sleep(1000);
      expect(finished).toBe(false);
      if (whileHeld) await whileHeld();
    } finally {
      release();
    }

    await first;
    return second;
  };

  // 🔴 `LEGACY-360`. Ручки переводов писали мимо замка строки тега, и импорт,
  // решивший «создать или обновить перевод» по снимку, получал `P2002`/`P2025`.
  // ⚠️ Одна вставка перевода ждала бы и без замка: внешний ключ на `Tag` берёт
  // `FOR KEY SHARE`, а он конфликтует с `FOR UPDATE`. Поэтому проверяется `Seo`:
  // до правки он писался на пуле и появлялся в базе, пока строка тега заперта.
  it('создание перевода ждёт замка строки тега, и Seo не пишется раньше', async () => {
    const tag = await makeTag('tr-create');
    const metaTitle = `${prefix}-tr-create-seo`;

    const created = await expectWaitsForLock(
      { id: tag.id },
      () =>
        tags.createTranslation(tag.id, {
          language: 'en',
          name: 'Created under lock',
          slug: `${prefix}-tr-create-en`,
          seo: { metaTitle },
        }),
      undefined,
      async () => {
        expect(await prisma.seo.count({ where: { metaTitle } })).toBe(0);
      },
    );

    expect(created).toMatchObject({ tagId: tag.id, language: 'en' });
    expect(await prisma.seo.count({ where: { metaTitle } })).toBe(1);
  }, 120_000);

  // `LEGACY-360`, п.2. Прежде `Seo` снимала ручная компенсация в `catch`, теперь —
  // откат транзакции. Мок отката не показывает, поэтому проверка на живой базе.
  it('конфликт слага при создании перевода не оставляет Seo-сироту', async () => {
    const owner = await makeTag('tr-conflict-owner');
    const other = await makeTag('tr-conflict-other');
    const slug = `${prefix}-tr-conflict-en`;
    await prisma.tagTranslation.create({
      data: { tagId: owner.id, language: 'en', name: 'Taken', slug },
    });
    const metaTitle = `${prefix}-tr-conflict-seo`;

    await expect(
      tags.createTranslation(other.id, {
        language: 'en',
        name: 'Conflicting',
        slug,
        seo: { metaTitle },
      }),
    ).rejects.toThrow('Translation with same (language, slug) already exists');

    expect(await prisma.seo.count({ where: { metaTitle } })).toBe(0);
    expect(await prisma.tagTranslation.count({ where: { tagId: other.id } })).toBe(0);
  }, 120_000);

  it('правка перевода ждёт замка строки тега', async () => {
    const tag = await makeTag('tr-update');
    await prisma.tagTranslation.create({
      data: { tagId: tag.id, language: 'en', name: 'Before', slug: `${prefix}-tr-update-en` },
    });

    await expectWaitsForLock({ id: tag.id }, () =>
      tags.updateTranslation(tag.id, 'en', { name: 'After' }),
    );

    const after = await prisma.tagTranslation.findUnique({
      where: { tagId_language: { tagId: tag.id, language: 'en' } },
    });
    expect(after?.name).toBe('After');
  }, 120_000);

  it('удаление перевода ждёт замка строки тега', async () => {
    const tag = await makeTag('tr-delete');
    await prisma.tagTranslation.create({
      data: { tagId: tag.id, language: 'en', name: 'Doomed', slug: `${prefix}-tr-delete-en` },
    });

    // Актёра нет намеренно: спека зовёт сервис напрямую, мимо HTTP, и проверяет
    // порядок захвата замка, а не проводку актёра (её держит `*.controller.actor.spec.ts`).
    await expectWaitsForLock({ id: tag.id }, () => tags.deleteTranslation(tag.id, 'en', null));

    const after = await prisma.tagTranslation.findUnique({
      where: { tagId_language: { tagId: tag.id, language: 'en' } },
    });
    expect(after).toBeNull();
  }, 120_000);

  // 🔴 `LEGACY-320`, остаток. `FOR UPDATE` по ключу, которого ещё нет в базе,
  // не запирал ничего: сосед создавал строку между пробой и `findUnique`.
  it('POST /tags ждёт замка ключа, строки которого ещё нет', async () => {
    const key = `${prefix}-new-by-admin`;

    await expect(
      expectWaitsForLock({ key }, () => tags.create({ name: 'Admin new', slug: key, key })),
    ).resolves.toMatchObject({ key });
  }, 120_000);

  it('импорт нового ключа ждёт встречного создателя и идёт веткой обновления', async () => {
    const key = `${prefix}-new-by-import`;

    const report = await expectWaitsForLock(
      { key },
      () =>
        imports.importTags([
          {
            key,
            name: 'Imported second',
            slug: `${key}-imported`,
            translations: { en: { name: 'Imported second', slug: `${key}-en` } },
          },
        ]),
      (tx) => tx.tag.create({ data: { name: 'Created first', slug: key, key } }),
    );

    // Строку создал держатель замка; импорт увидел её уже после его коммита.
    expect(report).toMatchObject({ imported: 0, updated: 1, errors: [] });
    const after = await prisma.tag.findUnique({ where: { key } });
    expect(after?.slug).toBe(`${key}-imported`);
  }, 120_000);
});

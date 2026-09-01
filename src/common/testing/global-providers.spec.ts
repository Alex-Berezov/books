import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { readFileSync } from 'fs';
import { relative, resolve } from 'path';
import { declaresOwnInstance, listModuleFiles, metadataElements } from './module-metadata';
import { BookModule } from '../../modules/book/book.module';
import { BookService } from '../../modules/book/book.service';
import { CategoryModule } from '../../modules/category/category.module';
import { CategoryService } from '../../modules/category/category.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PublicModule } from '../../modules/public/public.module';
import { ModeratorRolesModule } from '../roles/moderator-roles.module';
import { SlugRedirectModule } from '../../modules/slug-redirect/slug-redirect.module';
import { PrismaModule } from '../../shared/prisma/prisma.module';

/**
 * Сторож единственности провайдеров из `@Global()`-модулей
 * (`LEGACY-130` — `PrismaService`, `LEGACY-259` — `RolesGuard`).
 *
 * `PrismaModule` и `SecurityModule` помечены `@Global()` и экспортируют свои
 * провайдеры, поэтому объявлять их в `providers` любого другого модуля не нужно.
 * Nest на такое объявление отвечает не ошибкой, а вторым экземпляром. Для
 * `PrismaService` это дорого прямо: конструктор делает `new Pool`, то есть
 * у модуля появляется собственный пул соединений с PostgreSQL и собственный
 * контекст `$transaction`, который не видит транзакций соседа. Для `RolesGuard`
 * дешевле, но так же неверно: `@UseGuards(RolesGuard)` Nest разрешает сам, из
 * `module.injectables`, а не из `providers`, — строка в `providers` только
 * прячет, откуда гвард берётся.
 *
 * Ни типы, ни линт, ни e2e этого не показывают — контейнер собирается, маршруты
 * отвечают, а разница вылезает под нагрузкой (исчерпание пула) и в сценарии, где
 * два сервиса из разных модулей должны попасть в одну транзакцию.
 *
 * ⚠️ Спека лежит в `common/testing`, а не рядом с одним из владельцев: владельцев
 * двое, и «рядом с исходником» здесь означало бы две копии одного обхода.
 */

const SRC_ROOT = resolve(__dirname, '../..');

/** Провайдер и единственный модуль, которому позволено его объявлять. */
const GLOBAL_PROVIDERS = [
  {
    provider: 'PrismaService',
    owner: 'shared/prisma/prisma.module.ts',
    record: 'LEGACY-130',
  },
  {
    provider: 'RolesGuard',
    owner: 'shared/security/security.module.ts',
    record: 'LEGACY-259',
  },
];

/** Ниже этого числа обход считается сломанным, а не репозиторий — поредевшим. */
const MIN_MODULES = 50;

const relativeToSrc = (file: string): string => relative(SRC_ROOT, file).split('\\').join('/');

const readModules = (): Array<{ file: string; content: string }> =>
  listModuleFiles(SRC_ROOT).map((file) => ({
    file: relativeToSrc(file),
    content: readFileSync(file, 'utf8'),
  }));

describe('провайдеры глобальных модулей объявлены ровно в одном месте', () => {
  let moduleRef: TestingModule | undefined;

  // Контейнер поднимает настоящий `PrismaService`, а тот в конструкторе делает
  // `new Pool`. Закрытие стоит в `afterEach`, а не последней строкой кейса: при
  // упавшем `expect` до неё не дойдёт, `onModuleDestroy` не сработает и jest
  // поверх красного прогона повиснет на незакрытом пуле до таймаута.
  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  it('обход находит все модули репозитория', () => {
    expect(readModules().length).toBeGreaterThanOrEqual(MIN_MODULES);
  });

  it.each(GLOBAL_PROVIDERS)(
    '$provider объявлен и экспортирован своим модулем ($record)',
    ({ provider, owner }) => {
      // Без этого кейса `owner` работал бы только как фильтр-исключение: удали
      // провайдера у владельца или переименуй его каталог — и список нарушителей
      // остался бы пустым, хотя единственного законного объявления больше нет.
      const found = readModules().find(({ file }) => file === owner);

      expect(found).toBeDefined();
      expect(metadataElements(found?.content ?? '', 'providers')).toContain(provider);
      expect(metadataElements(found?.content ?? '', 'exports')).toContain(provider);
    },
  );

  it.each(GLOBAL_PROVIDERS)(
    '$provider не заводится заново ни в одном другом модуле ($record)',
    ({ provider, owner }) => {
      const offenders = readModules()
        .filter(({ file }) => file !== owner)
        .filter(({ content }) =>
          metadataElements(content, 'providers').some((element) =>
            declaresOwnInstance(element, provider),
          ),
        )
        .map(({ file }) => file);

      expect(offenders).toEqual([]);
    },
  );

  it('отдаёт сервисам разных модулей один и тот же клиент', async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        // `PrismaModule`, `SlugRedirectModule` и `ModeratorRolesModule` объявлены
        // `@Global()` в приложении — в тестовом контейнере глобальность не
        // наследуется, поэтому подаются явно.
        PrismaModule,
        SlugRedirectModule,
        ModeratorRolesModule,
        BookModule,
        CategoryModule,
        PublicModule,
      ],
    }).compile();

    const prisma = moduleRef.get(PrismaService);
    const inBook = moduleRef.select(BookModule).get(BookService, { strict: true });
    // `CategoryService` берётся из своего модуля: с 01.09.2026 `PublicModule` его не объявляет,
    // а импортирует владельца (`LEGACY-260`), и `strict: true` в чужом модуле его уже не найдёт.
    const inCategory = moduleRef.select(CategoryModule).get(CategoryService, { strict: true });

    // Поле приватно только для компилятора: тест смотрит именно на то, что
    // инжектор положил в сервис, — идентичность провайдера в контейнере вторым
    // экземпляром не ломается, а вот инжекция ломается.
    //
    // ⚠️ Сравнение идёт через размер множества, а не `toBe`: у клиента Prisma
    // круговая ссылка (`_originalClient`), и jest, сериализуя значения матчера
    // для родительского процесса, падает на ней ещё до вывода результата —
    // сьют краснеет целиком, независимо от того, сошлись экземпляры или нет.
    const clients = new Set<unknown>([
      prisma,
      (inBook as unknown as { prisma: PrismaService }).prisma,
      (inCategory as unknown as { prisma: PrismaService }).prisma,
    ]);

    expect(clients.size).toBe(1);
  });
});

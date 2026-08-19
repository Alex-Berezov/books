import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import { BookModule } from '../../modules/book/book.module';
import { BookService } from '../../modules/book/book.service';
import { CategoryService } from '../../modules/category/category.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PublicModule } from '../../modules/public/public.module';
import { ModeratorRolesModule } from '../../common/roles/moderator-roles.module';
import { SlugRedirectModule } from '../../modules/slug-redirect/slug-redirect.module';
import { PrismaModule } from './prisma.module';

/**
 * Сторож единственности `PrismaService` (`LEGACY-130`).
 *
 * `PrismaModule` помечен `@Global()` и экспортирует `PrismaService`, поэтому
 * объявлять его в `providers` любого другого модуля не нужно. Nest на такое
 * объявление отвечает не ошибкой, а вторым экземпляром: конструктор
 * `PrismaService` делает `new Pool`, то есть у модуля появляется собственный пул
 * соединений с PostgreSQL и собственный контекст `$transaction`, который не
 * видит транзакций соседа. Ни типы, ни линт, ни e2e этого не показывают —
 * контейнер собирается, маршруты отвечают, а разница вылезает под нагрузкой
 * (исчерпание пула) и в сценарии, где два сервиса из разных модулей должны
 * попасть в одну транзакцию.
 *
 * Первый кейс ловит возврат `PrismaService` в `providers` любого модуля;
 * второй — то, ради чего первый написан: клиент, доставшийся сервису из
 * `BookModule` и сервису из `PublicModule`, обязан быть тем же объектом, что и
 * клиент корневого контейнера.
 */

const SRC_ROOT = resolve(__dirname, '../..');

/** Единственное законное объявление — модуль, который его и экспортирует. */
const OWNER = 'shared/prisma/prisma.module.ts';

/** Ниже этого числа обход считается сломанным, а не репозиторий — поредевшим. */
const MIN_MODULES = 50;

const listModules = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listModules(full);
    return entry.isFile() && entry.name.endsWith('.module.ts') ? [full] : [];
  });

/**
 * Элементы верхнего уровня всех массивов `providers: [...]` файла.
 *
 * ⚠️ Две ловушки, и обе дают молчаливо неверный ответ.
 *
 * 1. **Скобки надо считать, а не сопоставлять регуляркой.** Ленивое
 *    `\[[\s\S]*?\]` заканчивает массив на первой же `]`, а внутри `providers`
 *    они бывают вложенные: у `HealthModule` там `inject: [ConfigService]`
 *    в пятой строке массива длиной в двадцать пять. Дописанный ниже
 *    `PrismaService` в такой блок не попадает - сторож зелен при вернувшемся
 *    дефекте, причём ровно в том модуле, из которого дубль только что убрали.
 * 2. **Считать надо элементы, а не вхождения имени в текст.** Тот же
 *    `HealthModule` называет `PrismaService` внутри массива дважды законно -
 *    типом параметра `useFactory` и токеном в `inject`. Поиск по тексту блока
 *    объявляет нарушением фабрику, которой сервис нужен аргументом, и правило
 *    начинают обходить, а не соблюдать.
 *
 * Отсюда разбор до элементов: запятые считаются только на нулевой глубине,
 * скобки всех трёх видов и строковые литералы пропускаются целиком.
 */
const providerElements = (content: string): string[] => {
  const elements: string[] = [];
  const opener = /providers:\s*\[/g;
  let match: RegExpExecArray | null;

  while ((match = opener.exec(content)) !== null) {
    let depth = 0;
    let quote: string | null = null;
    let current = '';

    for (let i = match.index + match[0].length; i < content.length; i += 1) {
      const ch = content[i];

      if (quote) {
        if (ch === quote && content[i - 1] !== '\\') quote = null;
        current += ch;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        current += ch;
        continue;
      }
      if (ch === '[' || ch === '{' || ch === '(') depth += 1;
      else if (ch === '}' || ch === ')') depth -= 1;
      else if (ch === ']') {
        if (depth === 0) {
          elements.push(current);
          opener.lastIndex = i + 1;
          break;
        }
        depth -= 1;
      } else if (ch === ',' && depth === 0) {
        elements.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
  }

  return elements.map((element) => element.trim()).filter(Boolean);
};

describe('PrismaService объявлен ровно в одном модуле (LEGACY-130)', () => {
  let moduleRef: TestingModule | undefined;

  // Контейнер поднимает настоящий `PrismaService`, а тот в конструкторе делает
  // `new Pool`. Закрытие стоит в `afterEach`, а не последней строкой кейса: при
  // упавшем `expect` до неё не дойдёт, `onModuleDestroy` не сработает и jest
  // поверх красного прогона повиснет на незакрытом пуле до таймаута.
  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  it('не встречается в providers ни одного модуля, кроме PrismaModule', () => {
    const modules = listModules(SRC_ROOT);

    expect(modules.length).toBeGreaterThanOrEqual(MIN_MODULES);

    const offenders = modules
      .map((file) => ({
        file: relative(SRC_ROOT, file).split('\\').join('/'),
        content: readFileSync(file, 'utf8'),
      }))
      .filter(({ file }) => file !== OWNER)
      .filter(({ content }) =>
        providerElements(content).some((element) => element === 'PrismaService'),
      )
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

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
        PublicModule,
      ],
    }).compile();

    const prisma = moduleRef.get(PrismaService);
    const inBook = moduleRef.select(BookModule).get(BookService, { strict: true });
    const inPublic = moduleRef.select(PublicModule).get(CategoryService, { strict: true });

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
      (inPublic as unknown as { prisma: PrismaService }).prisma,
    ]);

    expect(clients.size).toBe(1);
  });
});

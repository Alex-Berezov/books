import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BookController } from './book.controller';
import { BookService } from './book.service';
import type { CheckBookSlugQueryDto } from './dto/check-slug-query.dto';
import type { PaginationDto } from '../../shared/dto/pagination.dto';
import type { RateBookDto } from './dto/rate-book.dto';
import type { UpdateBookDto } from './dto/update-book.dto';

/**
 * Обработка ошибок в `BookController` (`LEGACY-113`).
 *
 * Все десять обработчиков этого контроллера обёрнуты в `try/catch`, и каждый
 * заворачивает пойманное в `HttpException` со статусом 500. Пропущенная строка
 * `if (err instanceof HttpException) throw err;` превращает 403 и 404 из сервиса
 * в 500 — а `SentryExceptionFilter` шлёт в Sentry именно 5xx, то есть отказ
 * в правах становится алертом о падении сервера.
 *
 * ⚠️ Проверяются **все десять мест, а не один метод**: пропущенная ветка catch
 * синтаксически ничем не отличается от полной, и `tsc`, линт и спеки сервиса
 * её не видят. Прошлая пачка показала, чем кончается проверка «на примере
 * одного метода»: защиту утверждали для четырёх операций из тринадцати.
 */

type ServiceMock = Record<string, jest.Mock>;

type HandlerCase = {
  /** Имя обработчика — оно же имя кейса в отчёте. */
  handler: string;
  /** Метод сервиса, который этот обработчик зовёт внутри `try`. */
  serviceMethod: string;
  /** Фраза, которой обработчик подменяет неожиданную ошибку. */
  message: string;
  invoke: (controller: BookController) => Promise<unknown>;
};

const user = { userId: 'u1', email: 'u1@example.com' };

const HANDLERS: HandlerCase[] = [
  {
    handler: 'checkSlug',
    serviceMethod: 'checkSlugExists',
    message: 'Failed to check slug',
    invoke: (c) => c.checkSlug({ slug: 'harry-potter' } as CheckBookSlugQueryDto),
  },
  {
    handler: 'getThemes',
    serviceMethod: 'getAllThemes',
    message: 'Failed to retrieve themes list',
    invoke: (c) => c.getThemes(),
  },
  {
    handler: 'overview',
    serviceMethod: 'getOverview',
    message: 'Failed to get book overview',
    invoke: (c) => c.overview('harry-potter', 'en', 'en-US'),
  },
  {
    handler: 'findAll',
    serviceMethod: 'findAll',
    message: 'Failed to retrieve books list',
    invoke: (c) => c.findAll({ page: 1, limit: 10 } as PaginationDto),
  },
  {
    handler: 'findBySlug',
    serviceMethod: 'findBySlug',
    message: 'Failed to get book by slug',
    invoke: (c) => c.findBySlug('harry-potter', { user }),
  },
  {
    handler: 'findOne',
    serviceMethod: 'findOne',
    message: 'Failed to get book',
    invoke: (c) => c.findOne('b1', { user }),
  },
  {
    handler: 'update',
    serviceMethod: 'update',
    message: 'Failed to update book',
    invoke: (c) => c.update('b1', {} as UpdateBookDto),
  },
  {
    handler: 'remove',
    serviceMethod: 'remove',
    message: 'Failed to delete book',
    invoke: (c) => c.remove('b1'),
  },
  {
    handler: 'rate',
    serviceMethod: 'rateBook',
    message: 'Failed to rate book',
    invoke: (c) => c.rate('b1', { user }, { score: 5 } as RateBookDto),
  },
  {
    handler: 'getMyRating',
    serviceMethod: 'getUserRating',
    message: 'Failed to get user rating',
    invoke: (c) => c.getMyRating('b1', { user }),
  },
];

const CONTROLLER_SOURCE = readFileSync(join(__dirname, 'book.controller.ts'), 'utf8');

const makeController = (serviceMethod: string, rejection: unknown): BookController => {
  const service: ServiceMock = {
    [serviceMethod]: jest.fn().mockRejectedValue(rejection),
    // `checkSlug` зовёт второй метод сервиса уже после первого; на пути отказа
    // до него не доходит, но мок должен существовать.
    generateUniqueSuggestedSlug: jest.fn().mockResolvedValue('harry-potter-2'),
  };
  return new BookController(service as unknown as BookService);
};

/**
 * Текст неожиданной ошибки, узнаваемый в любом поле ответа. Взят в форме,
 * в которой его печатает Prisma: именно она и утекала в поле `details`.
 */
const DRIVER_TEXT =
  'Invalid `prisma.bookVersion.findMany()` invocation: column "rights_holder_email" does not exist';

describe('BookController — исключение сервиса доходит до клиента как есть', () => {
  let logged: jest.SpyInstance;

  beforeEach(() => {
    logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => logged.mockRestore());

  // ⚠️ Оба счётчика намеренно не привязаны к имени пойманной переменной.
  // В репозитории живут оба написания — `catch (err)` и `catch (e)`, — и
  // одиннадцатый обработчик, написанный вторым способом, не должен проходить
  // мимо сторожа только из-за имени.
  it('перечень обработчиков совпадает с числом блоков catch в файле', () => {
    const catches = (CONTROLLER_SOURCE.match(/\bcatch\s*\(/g) ?? []).length;
    expect(HANDLERS).toHaveLength(catches);
  });

  it('переброс HttpException стоит в каждом блоке catch', () => {
    const catches = (CONTROLLER_SOURCE.match(/\bcatch\s*\(/g) ?? []).length;
    const rethrows = (CONTROLLER_SOURCE.match(/instanceof HttpException/g) ?? []).length;
    expect(rethrows).toBe(catches);
  });

  describe.each(HANDLERS)('$handler', ({ serviceMethod, message, invoke }) => {
    it('отдаёт 403 сервиса, а не собственные 500', async () => {
      const controller = makeController(serviceMethod, new ForbiddenException('нет прав'));
      await expect(invoke(controller)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('отдаёт 404 сервиса, а не собственные 500', async () => {
      const controller = makeController(serviceMethod, new NotFoundException('нет книги'));
      const error = await invoke(controller).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.NOT_FOUND);
    });

    it('неожиданную ошибку по-прежнему превращает в 500 со своей фразой', async () => {
      const controller = makeController(serviceMethod, new Error('прорвало базу'));
      const error = await invoke(controller).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      // Именно `toEqual`, а не `toMatchObject`: тело ответа сужено до одного
      // поля, и лишнее поле рядом с `message` обязано ронять спеку (`LEGACY-114`).
      expect((error as HttpException).getResponse()).toEqual({ message });
    });

    it('текст исключения в теле ответа не появляется ни в одном поле', async () => {
      const controller = makeController(serviceMethod, new Error(DRIVER_TEXT));
      const error = await invoke(controller).catch((e: unknown) => e);
      // Сравнение целиком, а не поиск подстроки: `not.toContain` здесь был бы
      // истинным при любом коде, который просто не эхоит эту фразу, — и не
      // покраснел бы от `details: err.stack`.
      expect((error as HttpException).getResponse()).toEqual({ message });
    });

    it('текст исключения уходит в лог — диагностика не потеряна', async () => {
      const controller = makeController(serviceMethod, new Error(DRIVER_TEXT));
      await invoke(controller).catch(() => undefined);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0][0])).toContain(DRIVER_TEXT);
    });

    it('исходное исключение сохраняется в cause — иначе Sentry получит заглушку', async () => {
      const original = new Error(DRIVER_TEXT);
      const controller = makeController(serviceMethod, original);
      const error = await invoke(controller).catch((e: unknown) => e);
      expect((error as HttpException).cause).toBe(original);
    });

    it('отказ не-Error объектом тоже оставляет след', async () => {
      const controller = makeController(serviceMethod, { code: 'P2024', clientVersion: '7.0.0' });
      const error = await invoke(controller).catch((e: unknown) => e);
      // `[object Object]` в логе означал бы, что причина отказа потеряна.
      expect(String(logged.mock.calls[0][0])).toContain('P2024');
      expect((error as HttpException).getResponse()).toEqual({ message });
    });
  });

  /**
   * Сторож на возврат дефекта в любом другом месте `src`, а не только в этом
   * контроллере (`LEGACY-114`, пункт 3 рекомендации).
   *
   * ⚠️ Шаблон ищет **текст пойманного исключения** в поле `details` при любом
   * имени переменной: в репозитории живут и `catch (err)`, и `catch (e)`, и
   * `catch (error)`. Статическая подсказка в `details` под запрет не подпадает
   * и живёт в этом же файле — `create()` отвечает на отключённый `POST /books`
   * телом с `details: 'Use POST /admin/rights/intakes/:id/create-book ...'`,
   * и её закрепляет `book.controller.spec.ts`.
   *
   * ⚠️ Чего сторож не ловит: тот же текст в поле с другим именем. Такие места
   * в репозитории есть и вынесены отдельными записями — `AuthorService` клеит
   * его в `message` (`LEGACY-196`), а `system-pages` и модули прав кладут
   * в поле `error` и в базу (`LEGACY-197`). Расширять шаблон на все имена
   * полей здесь нельзя: спека покраснеет на коде, который эта пачка не чинит.
   */
  it('текста исключения в поле details не осталось нигде в src', () => {
    const srcRoot = join(__dirname, '../..');
    const offenders: string[] = [];
    const leak = /details:\s*[^,\n}]*\b(err|error|e|ex|exception|cause)\b/;

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts'))
          continue;
        if (leak.test(readFileSync(full, 'utf8'))) {
          offenders.push(relative(srcRoot, full).replace(/\\/g, '/'));
        }
      }
    };

    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});

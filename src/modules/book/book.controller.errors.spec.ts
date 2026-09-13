import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { BookController } from './book.controller';
import { BookService } from './book.service';
import type { CheckBookSlugQueryDto } from './dto/check-slug-query.dto';
import type { PaginationDto } from '../../shared/dto/pagination.dto';
import type { RateBookDto } from './dto/rate-book.dto';
import type { UpdateBookDto } from './dto/update-book.dto';

/**
 * Обработка ошибок в `BookController` (`LEGACY-113`, `LEGACY-114`, `LEGACY-179`).
 *
 * 13.09.2026 решением владельца тело ошибки сведено к одной форме: контроллеры
 * исключений не ловят (`STYLE_GUIDE.md` §8), ответ формирует стандартный фильтр
 * Nest. До этого все десять обработчиков заворачивали неожиданный отказ
 * в собственное тело `{message}` со статусом 500 — третью форму тела в API.
 *
 * ⚠️ Проверяются **все десять мест, а не один метод**: одиночный `try/catch`,
 * вернувшийся в файл, синтаксически ничем не отличается от правильного кода,
 * и ни `tsc`, ни линт, ни спеки сервиса его не видят.
 *
 * ⚠️ Что здесь **не** проверяется: форма тела после сериализации. Спека читает
 * исключение до фильтра Nest; тело, уходящее анониму по проводу, закрывает
 * `test/book-error-body.e2e-spec.ts`.
 */

type ServiceMock = Record<string, jest.Mock>;

type HandlerCase = {
  /** Имя обработчика — оно же имя кейса в отчёте. */
  handler: string;
  /** Метод сервиса, который этот обработчик зовёт. */
  serviceMethod: string;
  invoke: (controller: BookController) => Promise<unknown>;
};

const user = { userId: 'u1', email: 'u1@example.com' };

const HANDLERS: HandlerCase[] = [
  {
    handler: 'checkSlug',
    serviceMethod: 'checkSlugExists',
    invoke: (c) => c.checkSlug({ slug: 'harry-potter' } as CheckBookSlugQueryDto),
  },
  { handler: 'getThemes', serviceMethod: 'getAllThemes', invoke: (c) => c.getThemes() },
  {
    handler: 'overview',
    serviceMethod: 'getOverview',
    invoke: (c) => c.overview('harry-potter', 'en', 'en-US'),
  },
  {
    handler: 'findAll',
    serviceMethod: 'findAll',
    invoke: (c) => c.findAll({ page: 1, limit: 10 } as PaginationDto),
  },
  {
    handler: 'findBySlug',
    serviceMethod: 'findBySlug',
    invoke: (c) => c.findBySlug('harry-potter', { user }),
  },
  { handler: 'findOne', serviceMethod: 'findOne', invoke: (c) => c.findOne('b1', { user }) },
  {
    handler: 'update',
    serviceMethod: 'update',
    invoke: (c) => c.update('b1', {} as UpdateBookDto),
  },
  { handler: 'remove', serviceMethod: 'remove', invoke: (c) => c.remove('b1') },
  {
    handler: 'rate',
    serviceMethod: 'rateBook',
    invoke: (c) => c.rate('b1', { user }, { score: 5 } as RateBookDto),
  },
  {
    handler: 'getMyRating',
    serviceMethod: 'getUserRating',
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

describe('BookController — исключение сервиса доходит до фильтра Nest как есть', () => {
  // ⚠️ Имя пойманной переменной в шаблон не входит: в репозитории живут
  // и `catch (err)`, и `catch (e)`, и `catch (error)`.
  it('в контроллере не осталось ни одного блока catch', () => {
    const catches = CONTROLLER_SOURCE.match(/\bcatch\s*\(/g) ?? [];
    expect(catches).toHaveLength(0);
  });

  it('контроллер не строит собственного тела ответа на отказ', () => {
    expect(CONTROLLER_SOURCE).not.toContain('internalFailure');
    expect(CONTROLLER_SOURCE).not.toMatch(/HttpStatus\.INTERNAL_SERVER_ERROR/);
  });

  describe.each(HANDLERS)('$handler', ({ serviceMethod, invoke }) => {
    it('отдаёт 403 сервиса, а не собственные 500', async () => {
      const original = new ForbiddenException('нет прав');
      const controller = makeController(serviceMethod, original);
      await expect(invoke(controller)).rejects.toBe(original);
    });

    it('отдаёт 404 сервиса, а не собственные 500', async () => {
      const original = new NotFoundException('нет книги');
      const controller = makeController(serviceMethod, original);
      await expect(invoke(controller)).rejects.toBe(original);
    });

    it('неожиданную ошибку пропускает как есть — её форму задаёт фильтр Nest', async () => {
      const original = new Error(DRIVER_TEXT);
      const controller = makeController(serviceMethod, original);
      // Именно `toBe`: обёртка в собственный `HttpException` — это возврат
      // третьей формы тела, ради снятия которой запись и заводилась.
      await expect(invoke(controller)).rejects.toBe(original);
    });

    it('отказ не-Error объектом тоже не подменяется', async () => {
      const original = { code: 'P2024', clientVersion: '7.0.0' };
      const controller = makeController(serviceMethod, original);
      await expect(invoke(controller)).rejects.toBe(original);
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
   * в поле `error` и в базу (`LEGACY-197`).
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

import { HttpException, HttpStatus } from '@nestjs/common';
import { BookController } from './book.controller';
import { BookService } from './book.service';
import type { PaginationDto } from '../../shared/dto/pagination.dto';

/**
 * WP-10.6 (R2-02) + WP-10.7 (R2-04). Phase 6 made an approved rights intake the only entrance for
 * a book. `test/book.e2e-spec.ts` already proves the HTTP contract of the disabled route, but the
 * guard also has to survive without a database: the risk R2-04 names is a refactor of the
 * controller quietly re-opening the route onto a service method that creates books without any
 * rights check.
 */
describe('BookController — direct book creation stays closed', () => {
  const controller = new BookController({} as BookService);

  it('answers POST /books with 400 and points at the rights intake workflow', () => {
    expect.assertions(3);
    try {
      controller.create();
    } catch (error) {
      const exception = error as HttpException;
      expect(exception).toBeInstanceOf(HttpException);
      expect(exception.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(exception.getResponse()).toEqual({
        message: 'Books must be created from an approved rights intake',
        details: 'Use POST /admin/rights/intakes/:id/create-book endpoint instead',
      });
    }
  });

  it('leaves BookService without a book-creating method to fall back on', () => {
    // The only sanctioned `book.create` in the backend lives in
    // `rights-intake/rights-book-creation.service.ts`, behind the approval workflow.
    expect(Object.getOwnPropertyNames(BookService.prototype)).not.toContain('create');
  });
});

/**
 * Единая форма списочного ответа на админском зеркале (`LEGACY-177`).
 *
 * 🔴 Форму здесь меняет **контроллер**, а не `BookService.findAll`: тем же методом
 * отвечает публичный `GET /:lang/books` (`public.controller.ts`), и его тело лежит
 * в edge-кэше Cloudflare — смена формы там требует сброса кэша на боевом домене
 * и остаётся за владельцем (решение арбитра 13.09.2026). Поэтому спека проверяет
 * не только то, что админ получил `{items, pagination}`, но и то, что сервису
 * по-прежнему разрешено отдавать `{data, meta}`: правка, «дочистившая» сервис,
 * сломает публичный кэшируемый ответ и обязана краснеть здесь.
 */
describe('BookController.findAll — админский список в форме {items, pagination}', () => {
  const page = {
    data: [{ id: 'b1' }, { id: 'b2' }],
    meta: { total: 42, page: 2, limit: 20, totalPages: 3 },
  };

  const makeController = (result: unknown): BookController =>
    new BookController({ findAll: jest.fn().mockResolvedValue(result) } as unknown as BookService);

  it('отдаёт тело целиком в новой форме, не оставляя рядом ни data, ни meta', async () => {
    const body = await makeController(page).findAll({ page: 2, limit: 20 } as PaginationDto);

    // Именно `toEqual` по всему телу: точечная проверка `body.items` осталась бы
    // зелёной и при `{items, pagination, data, meta}` — то есть при ответе,
    // который сводить формы и не начинал.
    expect(body).toEqual({
      items: [{ id: 'b1' }, { id: 'b2' }],
      pagination: { page: 2, limit: 20, total: 42, totalPages: 3 },
    });
  });

  it('строки страницы отдаются как есть — состав полей обёртка не трогает', async () => {
    const body = await makeController(page).findAll({ page: 2, limit: 20 } as PaginationDto);

    expect(body.items[0]).toBe(page.data[0]);
  });

  it('totalPages считает обёртка, а не сервис: при limit=0 это 0, а не Infinity', async () => {
    const body = await makeController({
      data: [],
      meta: { total: 7, page: 1, limit: 0, totalPages: Infinity },
    }).findAll({ page: 1, limit: 0 } as PaginationDto);

    expect(body.pagination.totalPages).toBe(0);
  });
});

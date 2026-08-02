import { HttpException, HttpStatus } from '@nestjs/common';
import { BookController } from './book.controller';
import { BookService } from './book.service';

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

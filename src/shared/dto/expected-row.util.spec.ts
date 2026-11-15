import { ConflictException } from '@nestjs/common';
import { assertRowAsExpected, recordChanged } from './expected-row.util';

/** 409 сверки вкладки — форма `codedConflict` с кодом `RECORD_CHANGED`. */
describe('recordChanged', () => {
  it('recordChanged — 409 с кодом RECORD_CHANGED и сообщением', () => {
    const e = recordChanged('changed');
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      code: 'RECORD_CHANGED',
      message: 'changed',
    });
  });

  it('assertRowAsExpected отказывает тем же ответом', () => {
    const run = () =>
      assertRowAsExpected(
        { updatedAt: new Date('2026-11-14T10:00:00.000Z') },
        { expectedUpdatedAt: '2026-11-14T09:00:00.000Z' },
        'changed',
      );
    expect(run).toThrow(ConflictException);
    try {
      run();
    } catch (e) {
      expect((e as ConflictException).getResponse()).toEqual(
        recordChanged('changed').getResponse(),
      );
    }
  });
});

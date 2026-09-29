import { plainToInstance } from 'class-transformer';
import { IsOptional, validateSync } from 'class-validator';
import { IsIsoDateTimeWithZone } from './iso-date-time-with-zone.decorator';

class WindowDto {
  @IsOptional()
  @IsIsoDateTimeWithZone()
  to?: string;
}

const errorsFor = (to: string): string[] =>
  validateSync(plainToInstance(WindowDto, { to })).flatMap((e) =>
    Object.values(e.constraints ?? {}),
  );

// Одна форма границы окна на журнал и претензии (`LEGACY-015` п.3, `LEGACY-426`).
describe('IsIsoDateTimeWithZone', () => {
  it.each([
    '2026-09-27T00:00:00Z',
    '2026-09-27T23:59:59.999Z',
    '2026-09-27T12:00+03:00',
    '2026-09-27T12:00:00-0500',
  ])('accepts a date-time with a zone: %s', (value) => {
    expect(errorsFor(value)).toEqual([]);
  });

  it('rejects a bare date: it would read as midnight UTC and cut the whole day', () => {
    expect(errorsFor('2026-09-27').join(' ')).toContain(
      'to must be an ISO date-time with a time zone',
    );
  });

  it('rejects a time without a zone: it would read in the server time zone', () => {
    expect(errorsFor('2026-09-27T12:00:00').join(' ')).toContain('time zone');
  });

  it('rejects a non-existent calendar date that new Date() would silently roll over', () => {
    expect(errorsFor('2026-02-30T00:00:00Z')).not.toEqual([]);
  });
});

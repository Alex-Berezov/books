import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ListAdminAuditEventsQueryDto } from './list-admin-audit-events-query.dto';

const USER_ID = '11111111-1111-4111-8111-111111111111';

const queryOf = (plain: Record<string, unknown>): ListAdminAuditEventsQueryDto =>
  plainToInstance(ListAdminAuditEventsQueryDto, plain);

const errorsOf = (plain: Record<string, unknown>): string[] =>
  validateSync(queryOf(plain)).map((e) => e.property);

describe('ListAdminAuditEventsQueryDto (LEGACY-015 пункт 3)', () => {
  it('targetId без targetType — ошибка на targetType', () => {
    expect(errorsOf({ targetId: USER_ID })).toEqual(['targetType']);
  });

  it('пара targetType+targetId проходит', () => {
    expect(errorsOf({ targetType: 'USER', targetId: USER_ID })).toEqual([]);
  });

  it('без фильтров проходит, targetType один — тоже', () => {
    expect(errorsOf({})).toEqual([]);
    expect(errorsOf({ targetType: 'BOOK' })).toEqual([]);
  });

  it('from/to — только дата-время с зоной', () => {
    expect(errorsOf({ from: '2026-09-27T00:00:00Z', to: '2026-09-27T23:59:59.999+03:00' })).toEqual(
      [],
    );
    expect(errorsOf({ to: '2026-09-27' })).toEqual(['to']);
    expect(errorsOf({ from: '2026-09-27T10:00' })).toEqual(['from']);
    expect(errorsOf({ to: '2026-02-30T00:00:00Z' })).toEqual(['to']);
    expect(errorsOf({ from: '0000-01-01T00:00:00Z' })).toEqual(['from']);
    expect(
      errorsOf({ from: '2026-09-27T00:00:00+0300', to: '2026-09-27T23:59:59.999999Z' }),
    ).toEqual([]);
  });

  it('limit выше потолка и нечисловой page отвергаются', () => {
    expect(errorsOf({ limit: '101' })).toEqual(['limit']);
    expect(errorsOf({ page: 'x' })).toEqual(['page']);
  });
});

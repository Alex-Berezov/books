import { paginated, totalPagesOf } from './paginated-response.dto';

/** `T82` (`LEGACY-016`): число страниц считается одним правилом. */
describe('totalPagesOf', () => {
  it.each([
    [0, 10, 0],
    [1, 10, 1],
    [10, 10, 1],
    [11, 10, 2],
    [101, 50, 3],
    [5, 0, 0],
    [0, 0, 0],
    [5, -5, 0],
  ])('total=%i limit=%i -> %i', (total, limit, expected) => {
    expect(totalPagesOf(total, limit)).toBe(expected);
  });

  it('paginated() берёт totalPages из того же правила', () => {
    expect(paginated([], { page: 1, limit: 0, total: 5 }).pagination.totalPages).toBe(0);
    expect(paginated([], { page: 1, limit: 10, total: 0 }).pagination.totalPages).toBe(0);
    expect(paginated([], { page: 2, limit: 10, total: 25 }).pagination.totalPages).toBe(3);
  });
});

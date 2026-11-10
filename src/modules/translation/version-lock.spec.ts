import { lockVersionRow } from './version-lock';

describe('lockVersionRow', () => {
  it('takes the row of this version FOR NO KEY UPDATE, one query', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    await lockVersionRow({ $queryRaw: queryRaw } as never, 'v1');
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [strings, id] = queryRaw.mock.calls[0] as [string[], string];
    expect(strings.join('$1')).toBe(
      'SELECT "id" FROM "BookVersion" WHERE "id" = $1 FOR NO KEY UPDATE',
    );
    expect(id).toBe('v1');
  });
});

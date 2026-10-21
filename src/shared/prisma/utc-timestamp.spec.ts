import { utcTimestamp } from './utc-timestamp';

describe('utcTimestamp', () => {
  it('passes the date as an ISO string with Z and converts it to UTC in SQL', () => {
    const sql = utcTimestamp(new Date('2026-10-21T10:00:00.000Z'));
    expect(sql.values).toEqual(['2026-10-21T10:00:00.000Z']);
    expect(sql.sql).toBe("(?::timestamptz AT TIME ZONE 'UTC')");
  });
});

import {
  JWT_ACCESS_SECRET_ENV,
  JWT_REFRESH_SECRET_ENV,
  assertJwtSecrets,
  requireJwtAccessSecret,
  requireJwtRefreshSecret,
} from './jwt-secrets';

function reader(values: Record<string, string | undefined>) {
  return (name: string) => values[name];
}

describe('jwt-secrets', () => {
  // Control landing 4 (CR auth-social): the process must refuse to start
  // without a real secret. Before this module every read site fell back to
  // 'dev_access_secret', so an unset variable booted silently.
  it('landing 4: refuses to start when the access secret is unset', () => {
    expect(() => assertJwtSecrets(reader({ [JWT_REFRESH_SECRET_ENV]: 'r4nd0m-refresh' }))).toThrow(
      /JWT_ACCESS_SECRET is not set/,
    );
  });

  it('landing 4: refuses to start when the refresh secret is unset', () => {
    expect(() => assertJwtSecrets(reader({ [JWT_ACCESS_SECRET_ENV]: 'r4nd0m-access' }))).toThrow(
      /JWT_REFRESH_SECRET is not set/,
    );
  });

  it('landing 4: refuses the well-known development fallbacks', () => {
    expect(() =>
      requireJwtAccessSecret(reader({ [JWT_ACCESS_SECRET_ENV]: 'dev_access_secret' })),
    ).toThrow(/well-known placeholder/);
    expect(() =>
      requireJwtRefreshSecret(reader({ [JWT_REFRESH_SECRET_ENV]: 'dev_refresh_secret' })),
    ).toThrow(/well-known placeholder/);
  });

  it('rejects a blank value the same way as a missing one', () => {
    expect(() => requireJwtAccessSecret(reader({ [JWT_ACCESS_SECRET_ENV]: '   ' }))).toThrow(
      /is not set/,
    );
  });

  it('returns the trimmed secret when it is set', () => {
    expect(requireJwtAccessSecret(reader({ [JWT_ACCESS_SECRET_ENV]: ' r4nd0m-access ' }))).toBe(
      'r4nd0m-access',
    );
    expect(() =>
      assertJwtSecrets(
        reader({
          [JWT_ACCESS_SECRET_ENV]: 'r4nd0m-access',
          [JWT_REFRESH_SECRET_ENV]: 'r4nd0m-refresh',
        }),
      ),
    ).not.toThrow();
  });
});

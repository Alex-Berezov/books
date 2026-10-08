/**
 * Single source of truth for the JWT signing secrets and token lifetimes.
 *
 * Every read site used to fall back to a hardcoded development string
 * (`'dev_access_secret'`). A fallback like that means the process starts
 * happily when the variable is missing — and then signs tokens with a value
 * that is published in this repository, so anyone could mint an `admin` token
 * without touching a single endpoint. The variable being set on production
 * today is not a property of the code, only of the deployment.
 *
 * Fail at boot instead, in the same shape as `assertPublicSiteUrl()`.
 *
 * Token lifetimes live here too, and unlike the secrets they do have safe defaults (`15m` / `7d`):
 * a missing lifetime cannot be used to forge a token, so it falls back instead of failing.
 */

import type { JwtSignOptions } from '@nestjs/jwt';

export const JWT_ACCESS_SECRET_ENV = 'JWT_ACCESS_SECRET';
export const JWT_REFRESH_SECRET_ENV = 'JWT_REFRESH_SECRET';

/** Reads one environment value. Lets ConfigService and `process.env` share this module. */
export type EnvReader = (name: string) => string | undefined;

/** Values that used to be silently substituted, plus the obvious placeholders. */
const REJECTED_SECRETS = new Set([
  'dev_access_secret',
  'dev_refresh_secret',
  'secret',
  'changeme',
  'change_me',
]);

export const processEnvReader: EnvReader = (name) => process.env[name];

/**
 * Return the secret named {@link name}, or throw if it is missing, blank or a
 * known placeholder.
 */
export function requireJwtSecret(name: string, read: EnvReader = processEnvReader): string {
  const value = read(name)?.trim();
  if (!value) {
    throw new Error(
      `${name} is not set. JWT secrets have no safe default: a fallback would sign tokens ` +
        'with a value published in the repository. Set it in the environment.',
    );
  }
  if (REJECTED_SECRETS.has(value.toLowerCase())) {
    throw new Error(
      `${name} is set to the well-known placeholder "${value}". Anyone reading the source ` +
        'could forge tokens with it. Use a random value.',
    );
  }
  return value;
}

const JWT_ACCESS_EXPIRES_IN_ENV = 'JWT_ACCESS_EXPIRES_IN';
const JWT_REFRESH_EXPIRES_IN_ENV = 'JWT_REFRESH_EXPIRES_IN';

/** Token lifetime for `jsonwebtoken`: an `ms`-style string (`'15m'`, `'7d'`); bare digits are read by `ms` as milliseconds. */
type JwtExpiresIn = NonNullable<JwtSignOptions['expiresIn']>;

/**
 * Token lifetime from the environment, or {@link fallback}. The value reaches `jsonwebtoken` as is,
 * exactly as before `@nestjs/jwt` 11.0.2: its types narrowed `expiresIn` to the `ms` format, which the
 * compiler cannot check on an env string, so a malformed value is still rejected by the signing call.
 */
function readJwtExpiresIn(name: string, fallback: JwtExpiresIn, read: EnvReader): JwtExpiresIn {
  const value = read(name);
  return value ? (value as JwtExpiresIn) : fallback;
}

export function readJwtAccessExpiresIn(read: EnvReader = processEnvReader): JwtExpiresIn {
  return readJwtExpiresIn(JWT_ACCESS_EXPIRES_IN_ENV, '15m', read);
}

export function readJwtRefreshExpiresIn(read: EnvReader = processEnvReader): JwtExpiresIn {
  return readJwtExpiresIn(JWT_REFRESH_EXPIRES_IN_ENV, '7d', read);
}

export function requireJwtAccessSecret(read: EnvReader = processEnvReader): string {
  return requireJwtSecret(JWT_ACCESS_SECRET_ENV, read);
}

export function requireJwtRefreshSecret(read: EnvReader = processEnvReader): string {
  return requireJwtSecret(JWT_REFRESH_SECRET_ENV, read);
}

/** Boot-time check: both secrets must be usable before anything starts listening. */
export function assertJwtSecrets(read: EnvReader = processEnvReader): void {
  requireJwtAccessSecret(read);
  requireJwtRefreshSecret(read);
}

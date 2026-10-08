import { Transform } from 'class-transformer';

/**
 * Адрес хранится в нижнем регистре (LEGACY-443): `User.email` — обычный `@unique`, и проверка
 * дубля по точной строке пропускала `Boss@x.com` при существующем `boss@x.com`.
 * Не строка уходит дальше как есть — отказывает `@IsEmail()`.
 */
export const normalizeEmail = (value: unknown): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export const NormalizeEmail = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => normalizeEmail(value));

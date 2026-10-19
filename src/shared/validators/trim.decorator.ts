import { Transform } from 'class-transformer';

/** Обрезка пробелов по краям строки до проверок; не строка проходит как есть. */
export const Trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

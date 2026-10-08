import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { NormalizeEmail, normalizeEmail } from './normalize-email.decorator';

class Probe {
  @NormalizeEmail()
  email!: unknown;
}

describe('normalizeEmail (LEGACY-443)', () => {
  it('обрезает пробелы и приводит к нижнему регистру', () => {
    expect(normalizeEmail('  Boss@Bibliaris.COM ')).toBe('boss@bibliaris.com');
  });

  it('не строку не трогает', () => {
    expect(normalizeEmail(undefined)).toBeUndefined();
    expect(normalizeEmail(5)).toBe(5);
  });

  it('декоратор применяет нормализацию при преобразовании тела', () => {
    expect(plainToInstance(Probe, { email: ' Boss@X.com' }).email).toBe('boss@x.com');
  });
});

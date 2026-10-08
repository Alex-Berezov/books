import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { LoginDto, RegisterDto } from './auth.dto';

// LEGACY-443: адрес хранится в нижнем регистре; без нормализации на входе `Boss@x.com`
// проходил проверку дубля мимо `boss@x.com`.
describe('auth DTO: email нормализуется (LEGACY-443)', () => {
  it.each([
    ['RegisterDto', RegisterDto],
    ['LoginDto', LoginDto],
  ])('%s приводит email к нижнему регистру без пробелов', (_name, cls) => {
    const dto = plainToInstance(cls as new () => { email: string }, { email: ' Boss@X.com ' });
    expect(dto.email).toBe('boss@x.com');
  });
});

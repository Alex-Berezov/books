import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto, RegisterDto, SocialLoginDto } from './auth.dto';

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

// T131 (слово владельца 14.10.2026): вход через соцсеть — только Google; другой провайдер
// отбивается валидацией тела, до проверки токена.
describe('SocialLoginDto: провайдер только google (T131)', () => {
  it('google принимается', async () => {
    const dto = plainToInstance(SocialLoginDto, { provider: 'google', token: 'id-token' });
    expect(await validate(dto)).toEqual([]);
  });

  it.each(['facebook', 'Google', ''])('%j отбивается', async (provider) => {
    const dto = plainToInstance(SocialLoginDto, { provider, token: 'id-token' });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toEqual(['provider']);
  });
});

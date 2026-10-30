import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  USER_NAME_MAX_LENGTH,
  USER_NICKNAME_MAX_LENGTH,
} from '../../../shared/constants/validation';
import { UpdateMeDto } from './update-me.dto';
import { RegisterDto } from '../../auth/dto/auth.dto';

const nameErrors = (cls: new () => object, name: string) =>
  validateSync(plainToInstance(cls, { name, email: 'a@b.cd', password: '12345678' })).filter(
    (e) => e.property === 'name',
  );

// LEGACY-462: имя профиля без верхней границы принималось любой длины.
// Регистрация — второй путь записи `User.name`, потолок тот же.
describe('потолок длины имени (LEGACY-462)', () => {
  it.each([
    ['UpdateMeDto', UpdateMeDto],
    ['RegisterDto', RegisterDto],
  ])('%s: ровно потолок проходит, на символ больше — нет', (_name, cls) => {
    expect(nameErrors(cls, 'a'.repeat(USER_NAME_MAX_LENGTH))).toEqual([]);
    expect(nameErrors(cls, 'a'.repeat(USER_NAME_MAX_LENGTH + 1))).not.toEqual([]);
  });
});

// LEGACY-471: ник без верхней границы принимался любой длины.
describe('потолок длины ника (LEGACY-471)', () => {
  const nicknameErrors = (nickname: string) =>
    validateSync(plainToInstance(UpdateMeDto, { nickname })).filter(
      (e) => e.property === 'nickname',
    );

  it('ровно потолок проходит, на символ больше — нет', () => {
    expect(nicknameErrors('a'.repeat(USER_NICKNAME_MAX_LENGTH))).toEqual([]);
    const [error] = nicknameErrors('a'.repeat(USER_NICKNAME_MAX_LENGTH + 1));
    expect(Object.keys(error.constraints ?? {})).toEqual(['maxLength']);
  });
});

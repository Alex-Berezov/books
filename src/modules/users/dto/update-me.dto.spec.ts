import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { USER_NAME_MAX_LENGTH } from '../../../shared/constants/validation';
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

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { CreateUserDto } from './create-user.dto';
import { UpdateUserDto } from './update-user.dto';

// LEGACY-443: админское создание и правка пишут тот же `User.email`, что регистрация.
describe('users DTO: email нормализуется (LEGACY-443)', () => {
  it.each([
    ['CreateUserDto', CreateUserDto],
    ['UpdateUserDto', UpdateUserDto],
  ])('%s приводит email к нижнему регистру без пробелов', (_name, cls) => {
    const dto = plainToInstance(cls as new () => { email: string }, { email: ' Boss@X.com ' });
    expect(dto.email).toBe('boss@x.com');
  });
});

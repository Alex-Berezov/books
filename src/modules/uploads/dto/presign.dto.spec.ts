import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PresignRequestDto } from './presign.dto';

describe('PresignRequestDto', () => {
  // F08-11a, решение арбитра `F08 | F08-11a` Q4: иллюстрации кладёт только генерация модели -
  // типа загрузки «illustration» нет, запрос отбивается валидацией, а не сервисом.
  it('refuses an illustration upload: no such upload type', async () => {
    const dto = plainToInstance(PresignRequestDto, {
      type: 'illustration',
      contentType: 'image/png',
      size: 1024,
    });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toEqual(['type']);
  });

  it.each(['cover', 'audio'])('accepts %s', async (type) => {
    const dto = plainToInstance(PresignRequestDto, { type, contentType: 'image/png', size: 1024 });
    expect(await validate(dto)).toEqual([]);
  });
});

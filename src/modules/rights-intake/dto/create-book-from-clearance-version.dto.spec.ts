import { CreateBookFromClearanceVersionDto } from './create-book-from-clearance-version.dto';
import { dtoFieldErrors } from '../../../common/testing/dto-field-errors';
import { versionPayload } from '../../book-version/dto/version-content-fields.fixture';

/**
 * Канал создания книги из клиренса принимает те же тела, что и обычное создание версии: разная
 * валидация одного поля означала бы 201 в одной форме и 400 в другой на одинаковом вводе.
 */
describe('CreateBookFromClearanceVersionDto: описание, обложка и реферальный адрес', () => {
  it('принимает пустые описание и обложку', () => {
    expect(
      dtoFieldErrors(
        CreateBookFromClearanceVersionDto,
        versionPayload({ description: '', coverImageUrl: '' }),
      ),
    ).toEqual([]);
  });

  it('отбивает нестроковую обложку', () => {
    expect(
      dtoFieldErrors(CreateBookFromClearanceVersionDto, versionPayload({ coverImageUrl: 123 })),
    ).toContain('coverImageUrl');
  });

  it('отбивает `null` там же, где его отбивает канал версий', () => {
    expect(
      dtoFieldErrors(CreateBookFromClearanceVersionDto, versionPayload({ description: null })),
    ).toContain('description');
    expect(
      dtoFieldErrors(CreateBookFromClearanceVersionDto, versionPayload({ coverImageUrl: null })),
    ).toContain('coverImageUrl');
  });

  it('по-прежнему требует настоящий адрес у заполненной обложки', () => {
    expect(
      dtoFieldErrors(
        CreateBookFromClearanceVersionDto,
        versionPayload({ coverImageUrl: 'not-a-url' }),
      ),
    ).toContain('coverImageUrl');
  });

  // Форма адреса обоих полей — общая таблица `src/common/testing/seo-url-fields.spec.ts`.
  // Та же пара, что у `referralUrl` канала версий (`@IsOptional()`): `null` — отсутствие поля,
  // пустая строка — не адрес.
  it('пропускает `null` и отбивает пустую строку в `referralUrl`', () => {
    expect(
      dtoFieldErrors(CreateBookFromClearanceVersionDto, versionPayload({ referralUrl: null })),
    ).toEqual([]);
    expect(
      dtoFieldErrors(CreateBookFromClearanceVersionDto, versionPayload({ referralUrl: '' })),
    ).toContain('referralUrl');
  });
});

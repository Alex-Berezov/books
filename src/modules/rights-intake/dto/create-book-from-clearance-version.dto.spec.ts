import { CreateBookFromClearanceVersionDto } from './create-book-from-clearance-version.dto';
import {
  contentFieldErrors,
  versionPayload,
} from '../../book-version/dto/version-content-fields.fixture';

/**
 * Канал создания книги из клиренса принимает те же тела, что и обычное создание версии: разная
 * валидация одного поля означала бы 201 в одной форме и 400 в другой на одинаковом вводе.
 */
describe('CreateBookFromClearanceVersionDto: описание и обложка', () => {
  it('принимает пустые описание и обложку', () => {
    expect(
      contentFieldErrors(
        CreateBookFromClearanceVersionDto,
        versionPayload({ description: '', coverImageUrl: '' }),
      ),
    ).toEqual([]);
  });

  it('отбивает нестроковую обложку', () => {
    expect(
      contentFieldErrors(CreateBookFromClearanceVersionDto, versionPayload({ coverImageUrl: 123 })),
    ).toContain('coverImageUrl');
  });

  it('отбивает `null` там же, где его отбивает канал версий', () => {
    expect(
      contentFieldErrors(CreateBookFromClearanceVersionDto, versionPayload({ description: null })),
    ).toContain('description');
    expect(
      contentFieldErrors(
        CreateBookFromClearanceVersionDto,
        versionPayload({ coverImageUrl: null }),
      ),
    ).toContain('coverImageUrl');
  });

  it('по-прежнему требует настоящий адрес у заполненной обложки', () => {
    expect(
      contentFieldErrors(
        CreateBookFromClearanceVersionDto,
        versionPayload({ coverImageUrl: 'not-a-url' }),
      ),
    ).toContain('coverImageUrl');
  });
});

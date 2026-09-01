import { ArgumentMetadata, BadRequestException } from '@nestjs/common';
import { RequiredStringPipe } from './required-string.pipe';

/**
 * Посадка `LEGACY-193`. Проверяется не «пайп что-то бросает», а ровно то, из-за
 * чего запись заведена: значение, которое раньше доходило до обработчика и
 * падало там `TypeError`, теперь отбивается как 400 и **не** доходит.
 */
describe('RequiredStringPipe', () => {
  const pipe = new RequiredStringPipe();
  const meta = { type: 'query', data: 'key' } as ArgumentMetadata;

  it('пропускает непустую строку без изменений', () => {
    expect(pipe.transform('covers/abc.jpg', meta)).toBe('covers/abc.jpg');
  });

  // Ровно тот вход, что давал 500: параметра в запросе нет, Nest передаёт
  // `undefined`, а сигнатура обработчика обещает `string`.
  it('отбивает отсутствующее значение как 400', () => {
    expect(() => pipe.transform(undefined, meta)).toThrow(BadRequestException);
  });

  it('отбивает пустую и пробельную строку как 400', () => {
    expect(() => pipe.transform('', meta)).toThrow(BadRequestException);
    expect(() => pipe.transform('   ', meta)).toThrow(BadRequestException);
  });

  // `?key=a&key=b` приходит массивом, `?key[x]=1` — объектом; и то и другое
  // разыменовывается в обработчике так же, как `undefined`.
  it('отбивает не-строку как 400', () => {
    expect(() => pipe.transform(['a', 'b'], meta)).toThrow(BadRequestException);
    expect(() => pipe.transform({ x: 1 }, meta)).toThrow(BadRequestException);
  });

  it('называет параметр по имени из метаданных, а не по зашитому слову', () => {
    expect(() => pipe.transform(undefined, meta)).toThrow('key is required');
    expect(() =>
      pipe.transform(undefined, { type: 'query', data: 'slug' } as ArgumentMetadata),
    ).toThrow('slug is required');
  });

  /**
   * Значение возвращается как пришло: обрезка меняла бы сам ключ, а ключ
   * объекта в хранилище — идентичность строки. Проверка нужна, чтобы `trim`
   * не завели «для симметрии» с проверкой пустоты.
   */
  it('не обрезает пробелы внутри непустого значения', () => {
    expect(pipe.transform(' covers/abc.jpg', meta)).toBe(' covers/abc.jpg');
  });

  it('не падает сам, когда имени параметра нет', () => {
    expect(() => pipe.transform(undefined, { type: 'query' } as ArgumentMetadata)).toThrow(
      'parameter is required',
    );
  });
});

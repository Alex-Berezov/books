import { plainToInstance } from 'class-transformer';
import { ValidationError, validateSync } from 'class-validator';
import { BOOK_WORLD_LIMITS as L } from './book-world-blocks.dto';
import { UpdateBookWorldDto, UpdateBookWorldEntityDto } from './update-book-world.dto';

/**
 * F08-1: форма импорта мира книги на границе — ровно предел проходит, на один больше — отказ с путём
 * поля, как у боевого `ValidationPipe` (`whitelist` + `forbidNonWhitelisted`).
 */
const paths = (errors: ValidationError[], prefix = ''): string[] =>
  errors.flatMap((e) => {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    return e.children && e.children.length > 0 ? paths(e.children, path) : [path];
  });

const validate = <T extends object>(cls: new () => T, body: Record<string, unknown>) =>
  paths(validateSync(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true }));

const hero = (over: Record<string, unknown> = {}) => ({
  key: 'oblomov',
  type: 'character',
  name: 'Oblomov',
  ...over,
});
const errorsOf = (entity: Record<string, unknown>) =>
  validate(UpdateBookWorldDto, { language: 'en', entities: [entity] });

const quotes = (n: number, text = 'q') =>
  Array.from({ length: n }, () => ({ text, chapter: 1, interpretation: 'i' }));

describe('aliasExclusions (F08-2): пределы на границе', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `form${i}`);

  it('ровно предел проходит, на один больше — отказ с путём', () => {
    expect(errorsOf(hero({ aliasExclusions: many(L.aliases) }))).toEqual([]);
    expect(errorsOf(hero({ aliasExclusions: many(L.aliases + 1) }))).toEqual([
      'entities.0.aliasExclusions',
    ]);
  });

  it('пустая строка, слишком длинная форма и не-массив — отказ', () => {
    expect(errorsOf(hero({ aliasExclusions: [''] }))).toEqual(['entities.0.aliasExclusions']);
    expect(errorsOf(hero({ aliasExclusions: ['x'.repeat(L.name + 1)] }))).toEqual([
      'entities.0.aliasExclusions',
    ]);
    expect(errorsOf(hero({ aliasExclusions: 'letter' }))).toEqual(['entities.0.aliasExclusions']);
  });

  it('null — снять исключения — проходит', () => {
    expect(errorsOf(hero({ aliasExclusions: null }))).toEqual([]);
  });
});

describe('UpdateBookWorldDto (F08-1)', () => {
  it('пределы D5 — те же числа, что у анализа', () => {
    expect(L).toMatchObject({ quotes: 12, quote: 500, interpretation: 3000, mediumText: 1500 });
  });

  it('минимальный герой проходит', () => {
    expect(errorsOf(hero())).toEqual([]);
  });

  it("type: 'place' принимается с F08-12a; неизвестный тип — отказ", () => {
    expect(errorsOf(hero({ type: 'place' }))).toEqual([]);
    expect(errorsOf(hero({ type: 'item' }))).toEqual(['entities.0.type']);
  });

  it('поля места (F08-12a): kind из двух значений, wikidataId по форме Q-номера, координат во входе нет', () => {
    expect(errorsOf(hero({ type: 'place', kind: 'real', wikidataId: 'Q90' }))).toEqual([]);
    expect(errorsOf(hero({ type: 'place', kind: 'mythic' }))).toEqual(['entities.0.kind']);
    expect(errorsOf(hero({ type: 'place', wikidataId: '90' }))).toEqual(['entities.0.wikidataId']);
    expect(errorsOf(hero({ type: 'place', wikidataId: 'Q0' }))).toEqual(['entities.0.wikidataId']);
    expect(errorsOf(hero({ type: 'place', geo: { lat: 1, lng: 2 } }))).toEqual(['entities.0.geo']);
    expect(errorsOf(hero({ type: 'place', significance: 'x'.repeat(L.significance + 1) }))).toEqual(
      ['entities.0.significance'],
    );
  });

  it('12 цитат проходят, 13 — отказ', () => {
    expect(errorsOf(hero({ quotes: quotes(L.quotes) }))).toEqual([]);
    expect(errorsOf(hero({ quotes: quotes(L.quotes + 1) }))).toEqual(['entities.0.quotes']);
  });

  it('цитата 500 знаков проходит, 501 — отказ с путём', () => {
    expect(errorsOf(hero({ quotes: quotes(1, 'x'.repeat(L.quote)) }))).toEqual([]);
    expect(errorsOf(hero({ quotes: quotes(1, 'x'.repeat(L.quote + 1)) }))).toEqual([
      'entities.0.quotes.0.text',
    ]);
  });

  it('лишний ключ — отказ', () => {
    expect(errorsOf(hero({ portrait: 'x' }))).toEqual(['entities.0.portrait']);
  });

  it('ключ A_b — отказ', () => {
    expect(errorsOf(hero({ key: 'A_b' }))).toEqual(['entities.0.key']);
  });

  it('цитата без главы — отказ (сверяется по своей главе)', () => {
    expect(errorsOf(hero({ quotes: [{ text: 'q', interpretation: 'i' }] }))).toEqual([
      'entities.0.quotes.0.chapter',
    ]);
  });

  it('этапы вложены в arc: 8 проходят, 9 — отказ', () => {
    const stages = (n: number) =>
      Array.from({ length: n }, () => ({ title: 't', text: 'x', chapter: 1 }));
    const arc = (n: number) => ({ from: 'a', to: 'b', stages: stages(n) });
    expect(errorsOf(hero({ arc: arc(L.stages) }))).toEqual([]);
    expect(errorsOf(hero({ arc: arc(L.stages + 1) }))).toEqual(['entities.0.arc.stages']);
  });

  it('пустое имя — отказ; имени нет — проходит (обязательность у новой — в сервисе)', () => {
    expect(errorsOf(hero({ name: '  ' }))).toEqual(['entities.0.name']);
    expect(errorsOf({ key: 'oblomov', type: 'character' })).toEqual([]);
  });

  it(`сущностей больше ${L.entities} — отказ`, () => {
    const entities = Array.from({ length: L.entities + 1 }, (_, i) => hero({ key: `h${i}` }));
    expect(validate(UpdateBookWorldDto, { language: 'en', entities })).toEqual(['entities']);
  });
});

describe('UpdateBookWorldEntityDto (F08-1)', () => {
  it('ключ в теле необязателен; type обязателен', () => {
    expect(validate(UpdateBookWorldEntityDto, { language: 'en', type: 'character' })).toEqual([]);
    expect(validate(UpdateBookWorldEntityDto, { language: 'en' })).toEqual(['type']);
  });
});

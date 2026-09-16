import { dtoFieldErrors } from '../../../common/testing/dto-field-errors';
import { UpdatePageDto } from './update-page.dto';

const errors = (payload: Record<string, unknown>) => dtoFieldErrors(UpdatePageDto, payload);

describe('UpdatePageDto: faq и sections (LEGACY-381)', () => {
  it('принимает пустую правку', () => {
    expect(errors({})).toEqual([]);
  });

  it('принимает faq: null', () => {
    expect(errors({ faq: null })).toEqual([]);
  });

  it('отбивает faq не-массивом', () => {
    expect(errors({ faq: { a: 1 } })).toContain('faq');
  });

  it('отбивает элемент faq вложенным массивом', () => {
    expect(errors({ faq: [[]] })).toContain('faq');
    expect(errors({ faq: [[{ question: 'Q', answer: 'A' }]] })).toContain('faq');
  });

  it('отбивает элемент faq с нестроковым полем', () => {
    expect(errors({ faq: [{ question: 1, answer: 'A' }] })).toContain('faq');
  });

  it('отбивает элемент faq с лишним полем', () => {
    expect(errors({ faq: [{ question: 'Q', answer: 'A', extra: true }] })).toContain('faq');
  });

  it('принимает верную форму faq', () => {
    expect(errors({ faq: [{ question: 'Q', answer: 'A' }] })).toEqual([]);
  });

  it('отбивает sections не-объектом', () => {
    expect(errors({ sections: 'not-an-object' })).toContain('sections');
    expect(errors({ sections: [1, 2] })).toContain('sections');
  });

  it('принимает произвольный объект sections без проверки ключей', () => {
    expect(errors({ sections: { bookCollections: [1, 2, 3] } })).toEqual([]);
  });
});

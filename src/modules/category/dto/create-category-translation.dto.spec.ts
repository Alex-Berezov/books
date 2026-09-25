import { Language } from '@prisma/client';
import { CreateCategoryTranslationDto } from './create-category-translation.dto';
import { dtoFieldErrors } from '../../../common/testing/dto-field-errors';

const translationPayload = (overrides: Record<string, unknown>) => ({
  language: Language.en,
  name: 'Victorian Literature',
  slug: 'victorian-literature',
  ...overrides,
});

const errors = (overrides: Record<string, unknown>) =>
  dtoFieldErrors(CreateCategoryTranslationDto, translationPayload(overrides));

describe('CreateCategoryTranslationDto: форма элемента faq (LEGACY-402)', () => {
  it('принимает верную форму faq', () => {
    expect(errors({ faq: [{ question: 'Q', answer: 'A' }] })).toEqual([]);
  });

  it('отбивает элемент faq без обязательных полей', () => {
    expect(errors({ faq: [{}] })).toContain('faq');
  });

  it('отбивает элемент faq с лишним полем', () => {
    expect(errors({ faq: [{ question: 'Q', answer: 'A', extra: true }] })).toContain('faq');
  });

  it('отбивает нестроковое поле элемента', () => {
    expect(errors({ faq: [{ question: 1, answer: 'A' }] })).toContain('faq');
  });
});

import { ImportCategoryTranslationDto } from './import-category.dto';
import { dtoFieldErrors } from '../../../common/testing/dto-field-errors';

const translationPayload = (overrides: Record<string, unknown>) => ({
  name: 'Victorian Literature',
  slug: 'victorian-literature',
  ...overrides,
});

const errors = (overrides: Record<string, unknown>) =>
  dtoFieldErrors(ImportCategoryTranslationDto, translationPayload(overrides));

describe('ImportCategoryTranslationDto: мягкость faq (LEGACY-401)', () => {
  it('принимает верную форму faq', () => {
    expect(errors({ faq: [{ question: 'Q', answer: 'A' }] })).toEqual([]);
  });

  it('отбивает элемент faq без обязательных полей', () => {
    expect(errors({ faq: [{}] })).toContain('faq');
  });

  it('отбивает элемент faq с лишним полем', () => {
    expect(errors({ faq: [{ question: 'Q', answer: 'A', extra: true }] })).toContain('faq');
  });

  it('отбивает `faq: null`, а не пропускает его в Prisma', () => {
    expect(errors({ faq: null })).toContain('faq');
  });
});

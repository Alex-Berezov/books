import { UpdateCategoryTranslationDto } from './update-category-translation.dto';
import { dtoFieldErrors } from '../../../common/testing/dto-field-errors';

describe('UpdateCategoryTranslationDto: форма элемента faq (LEGACY-402)', () => {
  it('принимает верную форму faq', () => {
    expect(
      dtoFieldErrors(UpdateCategoryTranslationDto, { faq: [{ question: 'Q', answer: 'A' }] }),
    ).toEqual([]);
  });

  it('отбивает элемент faq без обязательных полей', () => {
    expect(dtoFieldErrors(UpdateCategoryTranslationDto, { faq: [{}] })).toContain('faq');
  });

  it('отбивает элемент faq с лишним полем', () => {
    expect(
      dtoFieldErrors(UpdateCategoryTranslationDto, {
        faq: [{ question: 'Q', answer: 'A', extra: true }],
      }),
    ).toContain('faq');
  });
});

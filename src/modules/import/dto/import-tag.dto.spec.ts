import { ImportTagTranslationDto } from './import-tag.dto';
import { dtoFieldErrors } from '../../../common/testing/dto-field-errors';

const translationPayload = (overrides: Record<string, unknown>) => ({
  name: 'Aestheticism',
  slug: 'aestheticism',
  ...overrides,
});

const errors = (overrides: Record<string, unknown>) =>
  dtoFieldErrors(ImportTagTranslationDto, translationPayload(overrides));

describe('ImportTagTranslationDto: мягкость декораторов (LEGACY-401)', () => {
  it('принимает верную форму faq и related*Slugs', () => {
    expect(
      errors({
        faq: [{ question: 'Q', answer: 'A' }],
        relatedTagSlugs: ['beauty'],
        relatedGenreSlugs: ['gothic-fiction'],
        relatedCategorySlugs: ['victorian-literature'],
        relatedCollectionSlugs: ['classics'],
      }),
    ).toEqual([]);
  });

  it('отбивает элемент faq без обязательных полей', () => {
    expect(errors({ faq: [{}] })).toContain('faq');
  });

  it('отбивает элемент faq с лишним полем', () => {
    expect(errors({ faq: [{ question: 'Q', answer: 'A', extra: true }] })).toContain('faq');
  });

  // Форма слага у элементов `related*Slugs` намеренно не проверяется: админский PATCH той же
  // колонки её не проверяет, вводить на всех путях сразу — остаток `LEGACY-401` (`T57`).
  it('отбивает нестроковый элемент related*Slugs', () => {
    expect(errors({ relatedTagSlugs: [1] })).toContain('relatedTagSlugs');
    expect(errors({ relatedCollectionSlugs: [{}] })).toContain('relatedCollectionSlugs');
  });

  it('отбивает `indexable: null`, а не пропускает его в Prisma', () => {
    expect(errors({ indexable: null })).toContain('indexable');
  });

  it('отбивает `null` у faq и related*Slugs, а не пропускает его в Prisma', () => {
    expect(errors({ faq: null })).toContain('faq');
    expect(errors({ relatedTagSlugs: null })).toContain('relatedTagSlugs');
  });

  it('принимает отсутствие индексируемости', () => {
    expect(errors({})).toEqual([]);
  });
});

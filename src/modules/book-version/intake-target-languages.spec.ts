import { approvedTargetLanguages } from './intake-target-languages';

describe('approvedTargetLanguages (В8: one rule for manual versions and translation targets)', () => {
  it('a non-empty array is the list', () => {
    expect(approvedTargetLanguages(['en', 'fr'])).toEqual(['en', 'fr']);
  });

  it.each([[null], [undefined], [[]], [{}], ['en'], [0], [{ length: 2 }]])(
    '%p is no readable list - fails closed',
    (value) => {
      expect(approvedTargetLanguages(value)).toBeNull();
    },
  );
});

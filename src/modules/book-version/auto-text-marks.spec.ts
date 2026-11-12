import { autoTextRead, unreadAutoTextKinds } from './auto-text-marks';

/** `T184`: прочитан ли автотекст - сравнение отметки с последним вкладом модели. */
describe('auto-text marks (T184)', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 12, 10, 0, s));

  it('no model text - nothing to read, with or without a mark', () => {
    expect(autoTextRead(null, null)).toBe(true);
    expect(autoTextRead(null, at(1))).toBe(true);
  });

  it('model text without a mark is unread', () => {
    expect(autoTextRead(at(1), null)).toBe(false);
  });

  it('a mark not older than the model text reads it; an older one does not', () => {
    expect(autoTextRead(at(1), at(1))).toBe(true);
    expect(autoTextRead(at(1), at(2))).toBe(true);
    expect(autoTextRead(at(2), at(1))).toBe(false);
  });

  it('lists the unread kinds in the order summary, analysis', () => {
    expect(
      unreadAutoTextKinds({
        summaryAutoTextAt: at(2),
        summaryReadAt: at(1),
        analysisAutoTextAt: at(1),
        analysisReadAt: null,
      }),
    ).toEqual(['summary', 'analysis']);
    expect(
      unreadAutoTextKinds({
        summaryAutoTextAt: at(1),
        summaryReadAt: at(3),
        analysisAutoTextAt: null,
        analysisReadAt: null,
      }),
    ).toEqual([]);
  });
});

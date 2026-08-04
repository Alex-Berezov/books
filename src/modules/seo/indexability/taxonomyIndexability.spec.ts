import {
  CLOSE_AT_OR_BELOW,
  INDEXABLE_MIN_BOOKS,
  OPEN_AT_OR_ABOVE,
  resolveAutoIndexable,
} from './taxonomyIndexability';

describe('resolveAutoIndexable', () => {
  it('uses the documented thresholds', () => {
    expect(CLOSE_AT_OR_BELOW).toBe(2);
    expect(OPEN_AT_OR_ABOVE).toBe(5);
    expect(INDEXABLE_MIN_BOOKS).toBe(3);
  });

  it.each([0, 1, 2])('closes at %i books regardless of the previous state', (count) => {
    expect(resolveAutoIndexable(count, true)).toBe(false);
    expect(resolveAutoIndexable(count, false)).toBe(false);
  });

  it.each([5, 6, 42])('opens at %i books regardless of the previous state', (count) => {
    expect(resolveAutoIndexable(count, false)).toBe(true);
    expect(resolveAutoIndexable(count, true)).toBe(true);
  });

  it.each([3, 4])('holds the previous state at %i books (hysteresis band)', (count) => {
    expect(resolveAutoIndexable(count, true)).toBe(true);
    expect(resolveAutoIndexable(count, false)).toBe(false);
  });

  it('does not flap while the count oscillates around the threshold', () => {
    // A page opened at 5 stays open while the count wanders through 3-4...
    let state = resolveAutoIndexable(5, true);
    expect(state).toBe(true);
    state = resolveAutoIndexable(4, state);
    state = resolveAutoIndexable(3, state);
    state = resolveAutoIndexable(4, state);
    expect(state).toBe(true);

    // ...and only closes once it actually drops to 2.
    state = resolveAutoIndexable(2, state);
    expect(state).toBe(false);

    // Coming back up, 3-4 is not enough to reopen — 5 is.
    state = resolveAutoIndexable(3, state);
    state = resolveAutoIndexable(4, state);
    expect(state).toBe(false);
    state = resolveAutoIndexable(5, state);
    expect(state).toBe(true);
  });

  it('treats a brand-new term at the product threshold as indexable', () => {
    expect(resolveAutoIndexable(INDEXABLE_MIN_BOOKS, true)).toBe(true);
  });
});

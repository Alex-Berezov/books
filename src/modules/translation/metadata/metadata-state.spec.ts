import { metadataFailures, metadataRemarks, metadataStateOf } from './metadata-state';

describe('metadataStateOf', () => {
  it.each([
    ['a string', 'x'],
    ['an array', []],
    ['attempts not an array', { attempts: 'x', result: null }],
    ['a result that is not an object', { attempts: [], result: 'x' }],
  ])('a value of another form is no state: %s', (_name, value) => {
    expect(metadataStateOf(value)).toBeNull();
  });

  it('reads a state and counts its failures and last remarks', () => {
    const state = metadataStateOf({
      attempts: [
        { model: 'm', costUsd: '0.1', outcome: 'fail', remarks: ['first'] },
        { model: '', costUsd: '0.1', outcome: 'invalid', remarks: [] },
      ],
      result: null,
    });
    expect(state && metadataFailures(state)).toBe(2);
    expect(state && metadataRemarks(state)).toEqual([]);
  });
});

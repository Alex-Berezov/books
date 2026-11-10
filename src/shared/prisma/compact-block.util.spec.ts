import { compactBlock } from './compact-block.util';

describe('compactBlock', () => {
  it('no value - null: empty strings, empty lists and objects, nested too', () => {
    expect(compactBlock(undefined)).toBeNull();
    expect(compactBlock('  ')).toBeNull();
    expect(compactBlock({ a: ' ', b: [] })).toBeNull();
    expect(compactBlock([null, '', {}])).toBeNull();
  });

  it('strings are trimmed, empty fields and items dropped, a date stays a value', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    expect(compactBlock({ a: ' x ', b: [null, '', 'y'], at })).toEqual({ a: 'x', b: ['y'], at });
    expect(compactBlock(0)).toBe(0);
  });
});

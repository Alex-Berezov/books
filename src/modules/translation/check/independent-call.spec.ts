import { translatorsOf } from './independent-call';

describe('translatorsOf', () => {
  it('models of the pieces with text, each once; a piece without translatable blocks does not count', () => {
    expect(
      translatorsOf([
        { model: 'anthropic/a', blocks: [{ n: 1, text: 'x' }] },
        { model: 'anthropic/a', blocks: [{ n: 2, text: 'y' }] },
        { model: 'deepseek/b', blocks: [{ n: 3, text: 'z' }] },
        { model: null, blocks: [] },
      ]),
    ).toEqual(['anthropic/a', 'deepseek/b']);
    expect(translatorsOf([])).toEqual([]);
  });

  it('a piece with text and no recorded model: independence cannot be told', () => {
    expect(translatorsOf([{ model: null, blocks: [{ n: 1, text: 'x' }] }])).toBeNull();
    expect(translatorsOf([{ model: '', blocks: [{ n: 1, text: 'x' }] }])).toBeNull();
  });
});

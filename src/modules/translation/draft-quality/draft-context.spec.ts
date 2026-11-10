import { glossaryNames, glossaryText } from './draft-context';

describe('draft context', () => {
  const entries = [
    { key: 'k1', source: 'Anna', target: 'Анна' },
    { source: 'no key', target: 'x' },
  ];

  it('glossaryNames: only entries with key, source and target', () => {
    expect(glossaryNames({ entries })).toEqual([
      { key: 'k1', source: 'Anna', target: 'Анна', keepOriginal: false },
    ]);
    expect(glossaryNames(null)).toEqual([]);
  });

  it('glossaryText: glossary first, hero names of the dossier otherwise, "none" last', () => {
    const dossier = { characters: [{ name: 'Anna', variants: ['Annie', 3] }, { name: 7 }] };
    expect(glossaryText({ language: 'ru', dossier, glossary: { entries } })).toBe('Anna → Анна');
    expect(glossaryText({ language: 'ru', dossier, glossary: null })).toBe('Anna, Annie');
    expect(glossaryText({ language: 'ru', dossier: null, glossary: null })).toBe('none');
  });
});

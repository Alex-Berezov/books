import { findingKey, mergeFindings } from './glossary-findings';

describe('glossary findings of a piece (F05-4)', () => {
  const GLOSSARY = {
    entries: [
      {
        key: 'anna',
        source: 'Anna',
        target: 'Ana',
        kind: 'character',
        keepOriginal: false,
        note: '',
      },
    ],
    address: [],
    phrases: [{ source: 'Good day', target: 'Buen día' }],
  };
  const finding = (source: string, target = `${source}-es`) => ({
    source,
    target,
    kind: 'place',
    note: '',
  });

  it('adds new spellings with the piece in the history', () => {
    const merged = mergeFindings(GLOSSARY, [], 'c1', [finding('Town')]);
    expect(merged.added).toEqual([
      {
        key: findingKey('Town'),
        source: 'Town',
        target: 'Town-es',
        kind: 'place',
        keepOriginal: false,
        note: '',
      },
    ]);
    expect(merged.data.entries?.map((e) => e.source)).toEqual(['Anna', 'Town']);
    expect(merged.data.phrases).toEqual(GLOSSARY.phrases);
    expect(merged.history).toEqual([{ chunkId: 'c1', entries: merged.added }]);
  });

  it('never rewrites an entry or a phrase the glossary has, whatever the case', () => {
    const merged = mergeFindings(GLOSSARY, [], 'c1', [
      finding('anna', 'Anita'),
      finding('GOOD DAY'),
      finding('Town'),
      finding('town', 'Other'),
    ]);
    expect(merged.added.map((e) => [e.source, e.target])).toEqual([['Town', 'Town-es']]);
    expect(merged.data.entries?.[0]).toEqual(GLOSSARY.entries[0]);
  });

  it('a finding with a variant of a dossier character name is not a new entry', () => {
    const dossier = { characters: [{ key: 'anna', name: 'Anna', variants: ['Annie'] }] };
    const merged = mergeFindings(GLOSSARY, [], 'c1', [finding('Annie', 'Anita')], dossier);
    expect(merged.added).toEqual([]);
  });

  it('the same piece twice changes nothing', () => {
    const once = mergeFindings(GLOSSARY, [], 'c1', [finding('Town')]);
    const twice = mergeFindings(once.data, once.history, 'c1', [finding('River')]);
    expect(twice.added).toEqual([]);
    expect(twice.data).toEqual(once.data);
    expect(twice.history).toEqual(once.history);
  });

  it('a piece without new spellings leaves the history as it was', () => {
    const past = [{ chunkId: 'c0', entries: [] }];
    const merged = mergeFindings(GLOSSARY, past, 'c1', [finding('Anna')]);
    expect(merged.added).toEqual([]);
    expect(merged.history).toEqual(past);
  });
});

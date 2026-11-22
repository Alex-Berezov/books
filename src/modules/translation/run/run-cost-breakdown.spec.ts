import { Prisma } from '@prisma/client';
import { runCostBreakdown, sectionsSpent } from './run-cost-breakdown';
import type { RunSections } from './run-sections';

const d = (v: string) => new Prisma.Decimal(v);
const totals = (totalUsd: string, sectionsUsd = '0') => ({
  totalUsd: d(totalUsd),
  sectionsUsd: d(sectionsUsd),
});

describe('run cost breakdown', () => {
  it('splits calls by language and operation kind; a language without calls gets zeros; the rest is the difference to the total', () => {
    expect(
      runCostBreakdown(
        [
          { language: 'es', kind: 'translation_run', cost: d('0.5') },
          { language: 'es', kind: 'translation_retry', cost: d('0.25') },
          { language: 'fr', kind: 'translation_run', cost: d('1') },
          { language: 'es', kind: 'dossier', cost: d('0.03') },
          { language: null, kind: 'dossier', cost: d('0.1') },
          { language: null, kind: 'translation_run', cost: d('0.02') },
          // Язык не из запуска (задача чужого языка) - в остаток, а не в чужую строку.
          { language: 'ru', kind: 'translation_run', cost: d('0.4') },
          { language: 'pt', kind: 'translation_run', cost: null },
        ],
        ['es', 'fr', 'pt'],
        // Итог - все операции запуска; 0.2 - Summary и Analysis в строках языков.
        totals('2.5', '0.2'),
      ),
    ).toEqual({
      languages: [
        { language: 'es', translationUsd: '0.75000000', glossaryUsd: '0.03000000' },
        { language: 'fr', translationUsd: '1.00000000', glossaryUsd: '0.00000000' },
        { language: 'pt', translationUsd: '0.00000000', glossaryUsd: '0.00000000' },
      ],
      dossierUsd: '0.10000000',
      // 2.5 - 0.75 - 0.03 - 1 - 0.1 - 0.2 = 0.42: вызов без языка и вызов чужого языка.
      unattributedUsd: '0.42000000',
    });
  });

  it('a glossary of a language outside the run goes to the dossier, another operation kind to the rest', () => {
    expect(
      runCostBreakdown(
        [
          { language: 'ru', kind: 'dossier', cost: d('0.07') },
          { language: 'es', kind: 'compare', cost: d('0.3') },
          { language: null, kind: 'dossier', cost: null },
        ],
        ['es'],
        totals('0.37'),
      ),
    ).toEqual({
      languages: [{ language: 'es', translationUsd: '0.00000000', glossaryUsd: '0.00000000' }],
      dossierUsd: '0.07000000',
      unattributedUsd: '0.30000000',
    });
  });

  it('Write Summary spending not shown in a language row (its draft is gone) is in the rest, so the lines add up to the total', () => {
    const b = runCostBreakdown(
      [{ language: 'es', kind: 'translation_run', cost: d('1') }],
      ['es'],
      // 0.6 Summary в итоге есть, а в строке языка нет.
      totals('1.6', '0'),
    );
    expect(b.unattributedUsd).toBe('0.60000000');
  });

  it('a call settled between the reads (lines above the total) - the rest is zero, not negative', () => {
    const b = runCostBreakdown(
      [{ language: 'es', kind: 'translation_run', cost: d('1.1') }],
      ['es'],
      totals('1'),
    );
    expect(b.unattributedUsd).toBe('0.00000000');
  });

  it('no calls and no languages - zeros, not a failure', () => {
    expect(runCostBreakdown([], [], totals('0'))).toEqual({
      languages: [],
      dossierUsd: '0.00000000',
      unattributedUsd: '0.00000000',
    });
  });

  it('sectionsSpent sums Summary, Analysis and World of the language rows that have them', () => {
    const sections = new Map<string, RunSections>([
      [
        'l1',
        {
          summary: { spentUsd: '0.20000000' },
          analysis: { spentUsd: '0.30000000' },
          world: { spentUsd: '0.40000000' },
        },
      ],
      ['l2', { summary: null, analysis: { spentUsd: '0.05000000' }, world: null }],
      ['l3', { summary: null, analysis: null, world: { spentUsd: '0.01000000' } }],
    ] as unknown as Array<[string, RunSections]>);
    expect(sectionsSpent(sections).toFixed(8)).toBe('0.96000000');
  });
});

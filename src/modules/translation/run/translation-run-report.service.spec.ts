import { reportFindings } from './translation-run-report.service';

describe('report findings', () => {
  it('only known fields of their type; a finding without a code and the paid cost are not sent out', () => {
    expect(
      reportFindings([
        { code: 'SEAM_BROKEN', seam: 2, problems: ['lost', 3], costUsd: '0.1', model: 'm' },
        { code: 'GLOSSARY_SOURCE_FORM', key: 'anna', fragment: 'x'.repeat(900), extra: { a: 1 } },
        { seam: 1 },
        'CHAPTER_EMPTY',
        { code: 'CHUNK_FLAGGED', chunkIndex: '1' },
      ]),
    ).toEqual([
      { code: 'SEAM_BROKEN', seam: 2, problems: ['lost'], model: 'm' },
      { code: 'GLOSSARY_SOURCE_FORM', key: 'anna', fragment: 'x'.repeat(500) },
      { code: 'CHUNK_FLAGGED' },
    ]);
    expect(reportFindings(null)).toEqual([]);
  });
});

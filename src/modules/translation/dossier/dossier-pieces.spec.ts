import { LlmBudgetExceededError, LlmError } from '../../llm/llm.errors';
import { stepFailureCode } from '../../llm-worker/llm-worker.service';
import { PAUSE_BY_FAILURE } from '../pause-by-failure';
import {
  DOSSIER_PART_MAX_CHARS,
  nextPlannedPart,
  partKey,
  planChapterParts,
  planDossierParts,
  planEntries,
  readPlan,
} from './dossier-parts';
import {
  DOSSIER_PART_SHAPE,
  dossierChapterErrors,
  GLOSSARY_SHAPE,
  jsonSchemaOf,
  shapeErrors,
} from './dossier.format';
import {
  dossierPartRequest,
  dossierSummaryRequest,
  glossaryRequest,
  shapeRemark,
} from './dossier.prompts';

describe('planDossierParts', () => {
  it('one part per chapter with numbered translatable blocks; chapters without text give none', () => {
    const plans = planDossierParts([
      { number: 2, title: 'B', content: '<p>Beta</p><hr /><p>Gamma</p>' },
      { number: 1, title: 'A', content: '<p>Alpha</p>' },
      { number: 3, title: 'Empty', content: '<p>&ensp;</p>' },
    ]);
    expect(plans).toEqual([
      { chapterNumber: 1, chapterTitle: 'A', partIndex: 0, text: '[1] Alpha' },
      { chapterNumber: 2, chapterTitle: 'B', partIndex: 0, text: '[1] Beta\n[3] Gamma' },
    ]);
    expect(planEntries(plans)).toEqual([
      { chapterNumber: 1, parts: 1 },
      { chapterNumber: 2, parts: 1 },
    ]);
  });

  it('cuts a long chapter by blocks, never inside a block', () => {
    const paragraph = 'x'.repeat(DOSSIER_PART_MAX_CHARS / 4);
    const content = Array.from({ length: 10 }, () => `<p>${paragraph}</p>`).join('');
    const plans = planChapterParts({ number: 7, title: 'Long', content });
    expect(plans.length).toBeGreaterThan(1);
    expect(plans.map((p) => p.partIndex)).toEqual(plans.map((_, i) => i));
    const lines = plans.flatMap((p) => p.text.split('\n'));
    expect(lines).toHaveLength(10);
    expect(lines.every((l) => l.endsWith(paragraph))).toBe(true);
    expect(plans.every((p) => p.text.length <= DOSSIER_PART_MAX_CHARS + paragraph.length)).toBe(
      true,
    );
    expect(planEntries(plans)).toEqual([{ chapterNumber: 7, parts: plans.length }]);
  });

  it('a block longer than a piece is cut by characters, so no piece exceeds the limit', () => {
    const huge = 'y'.repeat(DOSSIER_PART_MAX_CHARS * 2 + 10);
    const plans = planChapterParts({ number: 1, title: 'Wall', content: huge });
    expect(plans.length).toBeGreaterThanOrEqual(3);
    expect(plans.every((p) => p.text.length <= DOSSIER_PART_MAX_CHARS)).toBe(true);
    expect(plans.map((p) => p.text).join('')).toBe(`[1] ${huge}`);
  });

  it('the next part is the first unsaved one of the stored plan', () => {
    const plan = readPlan([
      { chapterNumber: 1, parts: 2 },
      { chapterNumber: 4, parts: 1 },
      { junk: true },
    ]);
    expect(plan).toEqual([
      { chapterNumber: 1, parts: 2 },
      { chapterNumber: 4, parts: 1 },
    ]);
    expect(nextPlannedPart(plan, new Set())).toEqual({ chapterNumber: 1, partIndex: 0 });
    expect(nextPlannedPart(plan, new Set([partKey(1, 0)]))).toEqual({
      chapterNumber: 1,
      partIndex: 1,
    });
    expect(nextPlannedPart(plan, new Set([partKey(1, 0), partKey(1, 1)]))).toEqual({
      chapterNumber: 4,
      partIndex: 0,
    });
    expect(nextPlannedPart(plan, new Set([partKey(1, 0), partKey(1, 1), partKey(4, 0)]))).toBe(
      null,
    );
    expect(readPlan(null)).toEqual([]);
  });
});

describe('dossier form checks', () => {
  const part = {
    summary: 'S',
    characters: [{ name: 'A', variants: [], gender: 'f', whoIs: 'w', address: [], relations: [] }],
    entities: [{ name: 'Town', kind: 'place', whatIs: 'a town' }],
    events: [{ event: 'e', orderNote: '' }],
    voice: { notes: 'n', devices: [] },
    motifs: ['m'],
  };

  it('accepts an answer of the right form and ignores extra fields', () => {
    expect(shapeErrors({ ...part, extra: 1 }, DOSSIER_PART_SHAPE)).toEqual([]);
  });

  it('names every wrong place by path', () => {
    const wrong: Record<string, unknown> = {
      ...part,
      entities: [{ name: 'Town', kind: 'city', whatIs: 'a town' }],
      voice: { notes: 1, devices: [] },
    };
    delete wrong.motifs;
    expect(shapeErrors(wrong, DOSSIER_PART_SHAPE)).toEqual([
      '$.entities[0].kind: expected one of place, object, organization, term',
      '$.voice.notes: expected string',
      '$.motifs: expected array',
    ]);
    expect(shapeErrors(null, GLOSSARY_SHAPE)).toEqual(['$: expected object']);
  });

  it('describes the form as a strict JSON schema', () => {
    expect(jsonSchemaOf(GLOSSARY_SHAPE)).toMatchObject({
      type: 'object',
      required: ['entries', 'address', 'phrases'],
      additionalProperties: false,
    });
  });

  it('the summary must list every chapter with text and cite only existing chapters', () => {
    const dossier = {
      chapters: [{ number: 1 }, { number: 3 }],
      characters: [{ firstChapter: 1 }],
      entities: [{ firstChapter: 9 }],
      chronology: [{ chapter: 3 }],
      summaryPlan: [{ chapters: [1, 2] }],
      structure: { parts: [] },
      voice: { devices: [] },
      motifs: [{ chapters: [3] }],
    };
    expect(dossierChapterErrors(dossier, [1, 3], [1, 2, 3])).toEqual([
      '$.entities[].firstChapter: unknown reader chapters 9',
    ]);
    expect(dossierChapterErrors(dossier, [1, 2, 3], [1, 2, 3])).toEqual([
      '$.chapters: missing reader chapters 2',
      '$.entities[].firstChapter: unknown reader chapters 9',
    ]);
  });
});

describe('dossier prompts', () => {
  it('a piece request sends numbered blocks and the answer form in the system message', () => {
    const request = dossierPartRequest({
      chapterNumber: 3,
      chapterTitle: 'The Storm',
      partIndex: 0,
      text: '[1] It rained.\n[2] Anna ran.',
    });
    expect(request.jsonSchema.name).toBe('dossier_part');
    expect(request.messages[0].role).toBe('system');
    expect(request.messages[0].content).toContain('Answer with JSON only');
    expect(request.messages[0].content).toContain(JSON.stringify(jsonSchemaOf(DOSSIER_PART_SHAPE)));
    expect(request.messages[1]).toEqual({
      role: 'user',
      content: 'Reader chapter 3 "The Storm", piece 1.\n\n[1] It rained.\n[2] Anna ran.',
    });
  });

  it('the summary request carries the chapters, the partial dossiers and localized section titles', () => {
    const request = dossierSummaryRequest({
      chapters: [{ number: 1, title: 'One' }],
      parts: [{ chapterNumber: 1, partIndex: 0, data: { summary: 'S' } }],
    });
    expect(request.jsonSchema.name).toBe('dossier');
    expect(request.messages[0].content).toContain('"Глава 5"');
    expect(request.messages[0].content).toContain('"Capítulo 5"');
    expect(request.messages[0].content).toContain('"Première partie"');
    expect(request.messages[1].content).toBe(
      'Chapters: [{"number":1,"title":"One"}]\n\n' +
        'Partial dossiers: [{"chapterNumber":1,"partIndex":0,"data":{"summary":"S"}}]',
    );
  });

  it('only the summary schema stays in the text: Claude does not compile its grammar (Р1 F05-R)', () => {
    const summary = dossierSummaryRequest({ chapters: [], parts: [] });
    expect(summary.jsonSchema.textOnly).toBe(true);
    expect(summary.messages[0].content).toContain(JSON.stringify(summary.jsonSchema.schema));
    const part = dossierPartRequest({
      chapterNumber: 1,
      chapterTitle: 'A',
      partIndex: 0,
      text: '[1] A',
    });
    expect(part.jsonSchema).not.toHaveProperty('textOnly');
    expect(glossaryRequest({ dossier: {}, language: 'fr' }).jsonSchema).not.toHaveProperty(
      'textOnly',
    );
  });

  it('the glossary request names the target language', () => {
    const request = glossaryRequest({ dossier: { characters: [] }, language: 'fr' });
    expect(request.jsonSchema.name).toBe('glossary');
    expect(request.messages[0].content).toContain('into French (language code "fr")');
    expect(request.messages[1].content).toBe('Dossier: {"characters":[]}');
  });

  it.each([
    ['es', 'Spanish'],
    ['pt', 'Portuguese'],
    ['en', 'English'],
    ['ru', 'Russian'],
  ] as const)('the glossary into %s is asked as %s', (language, name) => {
    const request = glossaryRequest({ dossier: { characters: [] }, language });
    expect(request.messages[0].content).toContain(`into ${name} (language code "${language}")`);
  });

  it('a remark repeats the answer and lists the wrong places', () => {
    expect(shapeRemark('{"summary":1}', ['$.summary: expected string'])).toEqual([
      { role: 'assistant', content: '{"summary":1}' },
      {
        role: 'user',
        content:
          'The answer does not match the required JSON form. Fix these places and answer with ' +
          'the whole JSON again:\n$.summary: expected string',
      },
    ]);
  });
});

describe('budget failures pause the dossier builder (Р20)', () => {
  it.each([
    [new LlmBudgetExceededError('operation'), 'LIMIT_REACHED'],
    [new LlmBudgetExceededError('ceiling'), 'CEILING_REACHED'],
    [new LlmError('LLM_INSUFFICIENT_FUNDS', 'x'), 'INSUFFICIENT_FUNDS'],
    [new LlmError('LLM_NO_COMPLIANT_PROVIDER', 'x'), 'NO_COMPLIANT_PROVIDER'],
  ])('%s -> %s by the code the worker writes', (error, reason) => {
    expect(PAUSE_BY_FAILURE[stepFailureCode(error)]).toBe(reason);
  });

  it('other failures do not pause', () => {
    expect(PAUSE_BY_FAILURE[stepFailureCode(new LlmError('LLM_UNAVAILABLE', 'x'))]).toBe(undefined);
    expect(PAUSE_BY_FAILURE['TOO_MANY_ATTEMPTS']).toBe(undefined);
  });
});

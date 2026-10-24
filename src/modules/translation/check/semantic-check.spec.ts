import { shapeErrors } from '../dossier/dossier.format';
import {
  familyOf,
  independentModels,
  SEMANTIC_SHAPE,
  sampleSentences,
  seedOf,
  semanticAnswerOf,
  semanticFailed,
  semanticMessages,
  semanticRemarks,
} from './semantic-check';

const TEXT = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} ends here.`).join(' ');

const answer = (over: Record<string, unknown> = {}) =>
  semanticAnswerOf({
    verdict: 'pass',
    samples: [],
    omissions: [],
    nameFlags: [],
    remarks: [],
    ...over,
  });

describe('semantic check', () => {
  it('family is the prefix before the slash; the checker of the translating family is skipped', () => {
    expect(familyOf('anthropic/claude-sonnet-5.5')).toBe('anthropic');
    expect(
      independentModels(['anthropic/claude-opus-5.5', 'deepseek/v4', 'z-ai/glm'], 'anthropic/x'),
    ).toEqual(['deepseek/v4', 'z-ai/glm']);
    // Модель, переведшая кусок после перехода на запасную по 429, - её семейство.
    expect(independentModels(['deepseek/v4', 'z-ai/glm'], 'deepseek/v3')).toEqual(['z-ai/glm']);
    expect(independentModels(['deepseek/v4'], 'deepseek/v3')).toEqual([]);
  });

  it('a joint or a chapter of pieces by two models: the checker of either family is skipped', () => {
    const candidates = ['anthropic/claude', 'deepseek/v4', 'z-ai/glm'];
    expect(independentModels(candidates, ['anthropic/x', 'deepseek/v3'])).toEqual(['z-ai/glm']);
    expect(independentModels(candidates, ['anthropic/x', 'deepseek/v3', 'z-ai/y'])).toEqual([]);
  });

  it('the same seed samples the same 3-5 sentences; another seed - others', () => {
    const seed = seedOf('chunk-1');
    expect(seedOf('chunk-1')).toBe(seed);
    const first = sampleSentences(TEXT, seed);
    expect(sampleSentences(TEXT, seed)).toEqual(first);
    expect(first.length).toBeGreaterThanOrEqual(3);
    expect(first.length).toBeLessThanOrEqual(5);
    const others = [1, 2, 3, 4, 5].map((d) => sampleSentences(TEXT, seed + d).join('|'));
    expect(others.some((o) => o !== first.join('|'))).toBe(true);
  });

  it('a short source gives as many sentences as it has', () => {
    expect(sampleSentences('One. Two.', 7)).toEqual(['One.', 'Two.']);
  });

  it('fail, an inaccurate sample and a lost name of a sent key fail; unsure, inflected, pronoun and foreign keys do not', () => {
    const names = [
      { key: 'john', source: 'John', target: 'Juan' },
      { key: 'mary', source: 'Mary', target: 'María' },
    ];
    expect(semanticFailed(answer({ verdict: 'fail' }), names)).toBe(true);
    expect(semanticFailed(answer({ nameFlags: [{ key: 'john', verdict: 'lost' }] }), names)).toBe(
      true,
    );
    // pass с неточным образцом противоречит себе - провал (решение арбитра `F05 | F05-5`).
    expect(
      semanticFailed(
        answer({ samples: [{ source: 'a', translation: 'b', accurate: false }] }),
        names,
      ),
    ).toBe(true);
    // Названный пропуск - провал и при pass, и при unsure (§7 п.4).
    expect(semanticFailed(answer({ omissions: ['the last paragraph'] }), names)).toBe(true);
    expect(semanticFailed(answer({ verdict: 'unsure', omissions: ['the greeting'] }), names)).toBe(
      true,
    );
    expect(semanticFailed(answer({ verdict: 'unsure' }), names)).toBe(false);
    // Пропуск, названный словами «no» в начале, - всё равно пропуск.
    expect(
      semanticFailed(answer({ omissions: ['No mention of the letter in paragraph 3'] }), names),
    ).toBe(true);
    // «Ничего не пропущено» словами - не пропуск.
    for (const none of [
      'None',
      'None found',
      'nothing is missing',
      'Nothing is missing or added.',
      'No omissions.',
      'No omissions or additions',
      'No omissions detected',
      'Ninguna',
      'Нет',
      'None detected',
      'No missing content',
      'Нет пропусков',
      '-',
      ' ',
    ]) {
      expect(semanticFailed(answer({ omissions: [none] }), names)).toBe(false);
    }
    expect(
      semanticFailed(
        answer({
          nameFlags: [
            { key: 'john', verdict: 'inflected' },
            { key: 'mary', verdict: 'pronoun' },
          ],
        }),
        names,
      ),
    ).toBe(false);
    // Потерянное имя, которого на проверку не отправляли, - не провал.
    expect(semanticFailed(answer({ nameFlags: [{ key: 'ghost', verdict: 'lost' }] }), names)).toBe(
      false,
    );
  });

  it('an unknown verdict is a form error, not unsure', () => {
    const value = { verdict: 'maybe', samples: [], omissions: [], nameFlags: [], remarks: [] };
    expect(shapeErrors(value, SEMANTIC_SHAPE)).toEqual([
      '$.verdict: expected one of pass, fail, unsure',
    ]);
    expect(
      shapeErrors(
        { ...value, verdict: 'pass', nameFlags: [{ key: 'a', verdict: 'gone' }] },
        SEMANTIC_SHAPE,
      ),
    ).toHaveLength(1);
  });

  it('remarks carry the reviewer notes, inaccurate samples, omissions and the glossary form of a lost name', () => {
    const remarks = semanticRemarks(
      answer({
        verdict: 'fail',
        remarks: ['Sample 2 changes the meaning.'],
        samples: [{ source: 'He left.', translation: 'Llegó.', accurate: false }],
        omissions: ['the last paragraph'],
        nameFlags: [{ key: 'john', verdict: 'lost' }],
      }),
      [{ key: 'john', source: 'John', target: 'Juan' }],
    );
    expect(remarks).toEqual([
      'Sample 2 changes the meaning.',
      'Inaccurate: "He left." is rendered as "Llegó.".',
      'Missing or added: the last paragraph',
      'Keep the name "Juan" (source "John") as the glossary says.',
    ]);
  });

  it('the source and the translation go fenced as data, with the names to check', () => {
    const [system, user] = semanticMessages({
      sourceLanguage: 'en',
      targetLanguage: 'es',
      sourceText: 'John came.',
      translatedText: 'Juan vino.',
      samples: ['John came.'],
      names: [{ key: 'john', source: 'John', target: 'Juan' }],
    });
    expect(system.content).toContain('from English into Spanish');
    expect(user.content).toContain('<<<SOURCE\nJohn came.\nSOURCE>>>');
    expect(user.content).toContain('<<<TRANSLATION\nJuan vino.\nTRANSLATION>>>');
    expect(user.content).toContain('john: John → Juan');
  });
});

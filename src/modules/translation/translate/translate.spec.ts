import { Prisma } from '@prisma/client';
import { LlmBudgetExceededError, LlmError } from '../../llm/llm.errors';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskContext } from '../../llm-worker/llm-task.types';
import { ContestedWindow } from '../chunking/chapter-chunks';
import { callShaped } from '../llm-shaped-call';
import { pickBoundary } from './split.stage';
import { TRANSLATE_REMARKS } from './translate.constants';
import { shapeErrors } from '../dossier/dossier.format';
import {
  blockText,
  GLOSSARY_FINDING_TERM_MAX,
  GLOSSARY_FINDINGS_MAX,
  glossaryFindingsOf,
  TRANSLATE_SHAPE,
  translateBlockErrors,
} from './translate.format';
import { glossaryFor, lastTranslated, tailOf } from './translate-piece';
import { translateRequest } from './translate.prompts';

const ctx = {
  signal: new AbortController().signal,
  renewLease: jest.fn(),
  callOptions: { beforeAttempt: jest.fn(), signal: new AbortController().signal, taskId: 't' },
} as unknown as LlmTaskContext;

const answer = (json: unknown) => ({
  json,
  content: JSON.stringify(json),
  model: 'm/one',
  callId: 'call',
  costUsd: new Prisma.Decimal('0.01'),
});

describe('translate answer', () => {
  it('a missing block is a remark, then a refusal after two remarks', async () => {
    const llm = {
      callStage: jest
        .fn()
        .mockResolvedValue(answer({ blocks: [{ n: 1, text: 'Uno' }], glossaryFindings: [] })),
    };
    const result = await callShaped(
      llm as unknown as LlmService,
      'op',
      'translate',
      { messages: [{ role: 'user', content: 'x' }], jsonSchema: { name: 't', schema: {} } },
      TRANSLATE_SHAPE,
      ctx,
      { remarks: TRANSLATE_REMARKS, extraErrors: (v) => translateBlockErrors(v, [1, 2]) },
    );
    // Отказ несёт стоимость всех трёх ответов (В7).
    expect(result).toEqual({ ok: false, costUsd: new Prisma.Decimal('0.03') });
    // Первая попытка и два повтора с замечанием о недостающем блоке.
    expect(llm.callStage).toHaveBeenCalledTimes(3);
    const remark = (llm.callStage.mock.calls[1][2] as Array<{ content: string }>).at(-1);
    expect(remark?.content).toContain('missing blocks 2');
  });

  it('a fixed answer after a remark is taken and keeps the model option', async () => {
    const llm = {
      callStage: jest
        .fn()
        .mockResolvedValueOnce(answer({ blocks: [{ n: 1, text: 'Uno' }], glossaryFindings: [] }))
        .mockResolvedValueOnce(
          answer({
            blocks: [
              { n: 1, text: 'Uno' },
              { n: 2, text: 'Dos' },
            ],
            glossaryFindings: [],
          }),
        ),
    };
    const result = await callShaped(
      llm as unknown as LlmService,
      'op',
      'translate',
      { messages: [{ role: 'user', content: 'x' }], jsonSchema: { name: 't', schema: {} } },
      TRANSLATE_SHAPE,
      ctx,
      {
        remarks: TRANSLATE_REMARKS,
        model: 'm/one',
        extraErrors: (v) => translateBlockErrors(v, [1, 2]),
      },
    );
    expect(result).toMatchObject({ ok: true, callId: 'call' });
    expect(llm.callStage.mock.calls[0][3]).toMatchObject({ model: 'm/one', taskId: 't' });
  });

  it('block numbers: a foreign, repeated or empty block is an error', () => {
    expect(
      translateBlockErrors(
        {
          blocks: [
            { n: 1, text: 'a' },
            { n: 1, text: 'b' },
            { n: 9, text: 'c' },
            { n: 3, text: ' ' },
          ],
        },
        [1, 2, 3],
      ),
    ).toEqual([
      '$.blocks: block 1 is repeated',
      '$.blocks: block 9 is not in this piece',
      '$.blocks: missing blocks 2',
      '$.blocks: empty text in blocks 3',
    ]);
  });

  it('block text keeps inline markup only and drops what the white list does not allow', () => {
    expect(blockText({ kind: 'p', html: '' }, '<p>Hola <em>amigo</em><script>x</script></p>')).toBe(
      'Hola <em>amigo</em>',
    );
    expect(blockText({ kind: 'img-alt', html: '' }, 'Un "gato" <b>negro</b>')).toBe(
      'Un &quot;gato&quot; negro',
    );
  });

  it('an image stays only with a src the source block had: a foreign host is dropped', () => {
    const source = { kind: 'p' as const, html: 'A <img src="https://cdn.example/a.png"> cat' };
    expect(
      blockText(
        source,
        'Un <img src="https://cdn.example/a.png"> gato <img src="https://evil.example/x.png">',
      ),
    ).toBe('Un <img src="https://cdn.example/a.png"> gato');
    expect(
      blockText({ kind: 'p', html: 'No image' }, 'Sin <img src="https://cdn.example/a.png">'),
    ).toBe('Sin');
  });

  it('a link stays only with an href the source block had: a foreign one loses its tag, not its text', () => {
    const source = {
      kind: 'p' as const,
      html: 'See <a href="https://site.example/a?x=1&amp;y=2">the map</a>',
    };
    expect(
      blockText(
        source,
        'Ver <a href="https://site.example/a?x=1&y=2">el mapa</a> y <a href="https://evil.example/">aquí</a>.',
      ),
    ).toBe('Ver <a href="https://site.example/a?x=1&amp;y=2">el mapa</a> y aquí.');
    // Ссылка внутри чужой: закрывающие теги снимаются в паре со своими открывающими.
    expect(
      blockText(
        source,
        '<a href="https://evil.example/"><a href="https://site.example/a?x=1&amp;y=2">mapa</a> malo</a>',
      ),
    ).toBe('<a href="https://site.example/a?x=1&amp;y=2">mapa</a> malo');
    // Чистый исходник `sanitizeRichHtml` отдаёт байт в байт: `href` в одинарных кавычках - та же ссылка.
    expect(
      blockText(
        { kind: 'p', html: "See <a href='https://site.example/b'>it</a>" },
        'Ver <a href="https://site.example/b">eso</a>',
      ),
    ).toBe("Ver <a href='https://site.example/b'>eso</a>");
    expect(blockText({ kind: 'p', html: 'No link' }, '<a href="https://site.example/">x</a>')).toBe(
      'x',
    );
  });

  it('a link keeps the opening tag of the source: an href hidden in another attribute or invented target/rel do not pass', () => {
    const source = { kind: 'p' as const, html: 'See <a href="https://site.example/b">it</a>' };
    // `href` исходника внутри значения `rel`, настоящий `href` - чужой: ссылка снимается.
    expect(
      blockText(
        source,
        'Ver <a rel="x href=https://site.example/b" href="https://evil.example/">eso</a>',
      ),
    ).toBe('Ver eso');
    // Настоящий `href` - исходника: тег берётся из исходника, атрибуты модели не проходят.
    expect(
      blockText(
        source,
        'Ver <a href="https://site.example/b" target="_blank" rel="nofollow">eso</a>',
      ),
    ).toBe('Ver <a href="https://site.example/b">eso</a>');
    // Картинка - тот же разбор: `src` исходника внутри `title` чужой картинке не помогает.
    expect(
      blockText(
        { kind: 'p', html: 'A <img src="https://cdn.example/a.png"> cat' },
        'Un <img title=\' src="https://cdn.example/a.png"\' src="https://evil.example/x.png"> gato',
      ),
    ).toBe('Un  gato');
    // Значение без кавычек с `/` на конце - тот же адрес, что в кавычках.
    expect(
      blockText({ kind: 'p', html: 'See <a href=/docs/>docs</a>' }, 'Ver <a href="/docs/">doc</a>'),
    ).toBe('Ver <a href=/docs/>doc</a>');
    // Пустой `src` или `href` исходника ничего не разрешает: картинка и ссылка модели без адреса снимаются.
    expect(
      blockText(
        { kind: 'p', html: 'A <img src=""> <a href="">x</a>' },
        'Un <img alt="y"> <a>eso</a>',
      ),
    ).toBe('Un  eso');
  });

  it('glossary findings are not checked by the form: incomplete or missing ones are no reason to retry', () => {
    const blocks = [{ n: 1, text: 'Uno' }];
    expect(
      shapeErrors({ blocks, glossaryFindings: [{ source: 'Town' }] }, TRANSLATE_SHAPE),
    ).toEqual([]);
    expect(shapeErrors({ blocks }, TRANSLATE_SHAPE)).toEqual([]);
    // Остальная форма строгая: без блоков ответ не по форме.
    expect(shapeErrors({ glossaryFindings: [] }, TRANSLATE_SHAPE)).toEqual([
      '$.blocks: expected array',
    ]);
  });

  it('the dossier goes first, in the system message, and the blocks last', () => {
    const request = translateRequest({
      sourceLanguage: 'en',
      targetLanguage: 'es',
      context: { voice: 'dry', narration: null, setting: null, mainCharacters: [] },
      glossary: { entries: [], address: [], phrases: [] },
      chapterNumber: 3,
      chapterSummary: 'He leaves.',
      previousTail: 'Se fue.',
      blocks: [{ n: 4, html: 'He left.' }],
    });
    expect(request.messages[0].role).toBe('system');
    expect(request.messages[0].content).toContain('Book dossier: {"voice":"dry"');
    expect(request.messages[0].content).toContain('Spanish (language code "es")');
    expect(request.messages[1].content).toMatch(/Se fue\.[\s\S]*\[4\] He left\.$/);
  });
});

describe('translate input', () => {
  const dossier = {
    characters: [
      { key: 'john', name: 'John', variants: ['Johnny'], role: 'main' },
      { key: 'mary', name: 'Mary', variants: ['Mae'], role: 'secondary' },
      { key: 'tom', name: 'Tom', variants: [], role: 'episodic' },
    ],
  };
  const glossary = {
    entries: [
      { key: 'john', source: 'John' },
      { key: 'mary', source: 'Mary' },
      { key: 'tom', source: 'Tom' },
      { key: 'paris', source: 'Paris' },
    ],
    address: [
      { from: 'john', to: 'mary' },
      { from: 'tom', to: 'paris' },
    ],
    phrases: [{ source: 'my dear' }, { source: 'good grief' }],
  };

  it('takes entries seen in the text by spelling or variant, plus the main characters', () => {
    const picked = glossaryFor(glossary, dossier, 'Mae smiled in paris, my dear.');
    expect(picked.entries.map((e) => (e as { key: string }).key)).toEqual([
      'john',
      'mary',
      'paris',
    ]);
    expect(picked.address).toEqual([{ from: 'john', to: 'mary' }]);
    expect(picked.phrases).toEqual([{ source: 'my dear' }]);
  });

  it('the tail comes from the last non-empty piece: an hr-only piece is skipped', () => {
    const text = [{ n: 1, text: 'Uno' }];
    expect(lastTranslated([text, []])).toBe(text);
    expect(lastTranslated([[], []])).toBeUndefined();
    expect(lastTranslated([])).toBeUndefined();
  });

  it('the tail of the previous piece is its last blocks within the cap', () => {
    expect(tailOf([])).toBeNull();
    const long = 'x'.repeat(1_495);
    expect(
      tailOf([
        { n: 1, text: 'first' },
        { n: 2, text: long },
        { n: 3, text: 'last' },
      ]),
    ).toBe(`${long}\nlast`);
  });
});

describe('pickBoundary (split stage)', () => {
  const window: ContestedWindow = {
    candidates: [
      { block: 5, words: 1_600, beforeDialogue: false, head: 'a' },
      { block: 8, words: 2_300, beforeDialogue: false, head: 'b' },
    ],
  };

  it('takes the block the model chose', async () => {
    const llm = { callStage: jest.fn().mockResolvedValue(answer({ boundaryBlock: 5 })) };
    await expect(pickBoundary(llm as unknown as LlmService, 'op', window, ctx)).resolves.toBe(5);
  });

  it('a model refusal falls back to the code boundary (Р7)', async () => {
    const llm = {
      callStage: jest.fn().mockRejectedValue(new LlmError('LLM_NO_COMPLIANT_PROVIDER', 'none')),
    };
    await expect(pickBoundary(llm as unknown as LlmService, 'op', window, ctx)).resolves.toBe(8);
  });

  it('an answer outside the window twice falls back to the code boundary', async () => {
    const llm = { callStage: jest.fn().mockResolvedValue(answer({ boundaryBlock: 6 })) };
    await expect(pickBoundary(llm as unknown as LlmService, 'op', window, ctx)).resolves.toBe(8);
    expect(llm.callStage).toHaveBeenCalledTimes(2);
  });

  it('a budget refusal is not swallowed: the operation must pause', async () => {
    const llm = { callStage: jest.fn().mockRejectedValue(new LlmBudgetExceededError('operation')) };
    await expect(
      pickBoundary(llm as unknown as LlmService, 'op', window, ctx),
    ).rejects.toBeInstanceOf(LlmBudgetExceededError);
  });
});

describe('glossary findings of a translation answer (F05-4)', () => {
  it('takes only findings with both spellings from the answer', () => {
    expect(
      glossaryFindingsOf({
        blocks: [],
        glossaryFindings: [
          { source: ' Town ', target: 'Pueblo', kind: 'place' },
          { source: 'River', target: '' },
          { source: 3, target: 'x' },
          'junk',
          null,
        ],
      }),
    ).toEqual([{ source: 'Town', target: 'Pueblo', kind: 'place', note: '' }]);
    expect(glossaryFindingsOf({ blocks: [] })).toEqual([]);
  });

  it('drops overlong findings and keeps at most the limit; no answer - no findings', () => {
    const long = 'x'.repeat(GLOSSARY_FINDING_TERM_MAX + 1);
    const many = Array.from({ length: GLOSSARY_FINDINGS_MAX + 5 }, (_, i) => ({
      source: `Term${i}`,
      target: `t${i}`,
    }));
    expect(glossaryFindingsOf({ glossaryFindings: [{ source: long, target: 'x' }] })).toEqual([]);
    expect(glossaryFindingsOf({ glossaryFindings: many })).toHaveLength(GLOSSARY_FINDINGS_MAX);
    expect(glossaryFindingsOf(null)).toEqual([]);
    // Одна-две буквы - не термин: подстрокой нашлись бы в каждом куске.
    expect(glossaryFindingsOf({ glossaryFindings: [{ source: 'an', target: 'un' }] })).toEqual([]);
    expect(glossaryFindingsOf({ glossaryFindings: [{ source: 'I', target: 'Yo' }] })).toEqual([]);
    // Имя из двух букв - герой, а не служебное слово: в глоссарий кусков оно идёт только там,
    // где встречено целым словом.
    const glossary = {
      entries: [{ key: 'found:li', source: 'Li', target: 'Ли' }],
      address: [],
      phrases: [],
    };
    expect(glossaryFor(glossary, {}, 'she would like a little tea').entries).toEqual([]);
    expect(glossaryFor(glossary, {}, 'and li smiled').entries).toHaveLength(1);
    expect(
      glossaryFindingsOf({ glossaryFindings: [{ source: 'Li', target: 'Ли', kind: 'name' }] }),
    ).toEqual([{ source: 'Li', target: 'Ли', kind: 'name', note: '' }]);
  });
});

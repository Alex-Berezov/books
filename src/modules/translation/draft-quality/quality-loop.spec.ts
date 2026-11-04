import { Prisma } from '@prisma/client';
import { LlmError } from '../../llm/llm.errors';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskContext } from '../../llm-worker/llm-task.types';
import { Shape } from '../dossier/dossier.format';
import { shapedRequest } from '../dossier/dossier.prompts';
import { QualityLoopSpec, Redo, runQualityLoop } from './quality-loop';
import { codeRemark, DraftRemark } from './text-checks';

/**
 * Цикл качества (`F06-1`, шаг 4; `product.md` §3) на подменённом модуле LLM: замечание - ровно
 * одна переделка и итог с флагами; без замечаний - без переделки; проверяющая другого семейства,
 * чем фактически ответивший автор.
 */

const AUTHOR_STAGE = 'test_write';
const REVIEW_STAGE = 'test_review';
const TEXT: Shape = { object: { text: 'string' as const } };

interface Call {
  stage: string;
  model?: string;
  fallbacks?: readonly string[];
}

/**
 * Ответ подменённого `callStage` по очереди этапа: значение и модель, ответившая на вызов, или
 * отказ модуля LLM.
 */
type Reply = { json: unknown; model: string } | Error;

function fakeLlm(replies: Record<string, Reply[]>, reviewCandidates: string[], fits = true) {
  const calls: Call[] = [];
  const llm = {
    callStage: jest.fn(
      (
        _op: string,
        stage: string,
        _messages: unknown,
        options: { model?: string; fallbacks?: readonly string[] },
      ) => {
        calls.push({ stage, model: options.model, fallbacks: options.fallbacks });
        const reply = replies[stage].shift();
        if (!reply) throw new Error(`no reply for ${stage}`);
        if (reply instanceof Error) return Promise.reject(reply);
        return Promise.resolve({
          json: reply.json,
          content: JSON.stringify(reply.json),
          model: reply.model,
          callId: `c${calls.length}`,
          costUsd: new Prisma.Decimal('0.01'),
          afterTruncation: false,
        });
      },
    ),
    stageCallModels: jest.fn(() => Promise.resolve(reviewCandidates)),
    stageFit: jest.fn(() => Promise.resolve({ fits })),
  };
  return { llm: llm as unknown as LlmService, calls };
}

const ctx = { callOptions: {} } as unknown as LlmTaskContext;

function spec(
  codeCheck: (draft: string) => DraftRemark[],
  redos: Array<Redo<string> | null>,
): QualityLoopSpec<string> {
  return {
    authorStage: AUTHOR_STAGE,
    authorShape: TEXT,
    authorModels: { model: 'z-ai/glm-5.3', fallbacks: ['openai/gpt-5.6-terra'] },
    authorRequest: (redo) => {
      redos.push(redo);
      return shapedRequest('w', TEXT, [{ role: 'user', content: 'write' }]);
    },
    readAuthor: (value) => (value as { text: string }).text,
    codeCheck,
    reviewStage: REVIEW_STAGE,
    reviewModels: {},
    reviewRequest: () => shapedRequest('r', TEXT, [{ role: 'user', content: 'review' }]),
  };
}

const ok = { verdict: 'ok', remarks: [] };
const styleRemark = {
  verdict: 'remarks',
  remarks: [{ code: 'STYLE_POOR', where: 'Anna', note: 'calque' }],
};

describe('runQualityLoop', () => {
  it('no remarks - no redo, verdict ok', async () => {
    const { llm, calls } = fakeLlm(
      {
        [AUTHOR_STAGE]: [{ json: { text: 'clean' }, model: 'z-ai/glm-5.3' }],
        [REVIEW_STAGE]: [{ json: ok, model: 'openai/gpt-6-luna' }],
      },
      ['openai/gpt-6-luna', 'deepseek/deepseek-v4-pro'],
    );
    const redos: Array<Redo<string> | null> = [];
    const result = await runQualityLoop(
      llm,
      'op',
      ctx,
      spec(() => [], redos),
    );
    expect(result).toMatchObject({
      ok: true,
      draft: 'clean',
      attempt: 1,
      verdict: 'ok',
      remarks: [],
    });
    expect(redos).toEqual([null]);
    expect(calls.map((c) => c.stage)).toEqual([AUTHOR_STAGE, REVIEW_STAGE]);
    expect(result.ok && result.costUsd.toString()).toBe('0.02');
  });

  it('a remark - exactly one redo with the remarks; what is left is a flag', async () => {
    const { llm, calls } = fakeLlm(
      {
        [AUTHOR_STAGE]: [
          { json: { text: 'first' }, model: 'z-ai/glm-5.3' },
          { json: { text: 'second' }, model: 'z-ai/glm-5.3' },
        ],
        [REVIEW_STAGE]: [
          { json: styleRemark, model: 'openai/gpt-6-luna' },
          { json: styleRemark, model: 'openai/gpt-6-luna' },
        ],
      },
      ['openai/gpt-6-luna'],
    );
    const redos: Array<Redo<string> | null> = [];
    const lengthOut = codeRemark('LENGTH_OUT', '10 words', 'too short');
    const result = await runQualityLoop(
      llm,
      'op',
      ctx,
      spec((draft) => (draft === 'first' ? [lengthOut] : []), redos),
    );
    expect(calls.map((c) => c.stage)).toEqual([
      AUTHOR_STAGE,
      REVIEW_STAGE,
      AUTHOR_STAGE,
      REVIEW_STAGE,
    ]);
    expect(redos).toHaveLength(2);
    expect(redos[1]).toEqual({
      previous: 'first',
      remarks: [lengthOut, { code: 'STYLE_POOR', where: 'Anna', note: 'calque', by: 'model' }],
    });
    expect(result).toMatchObject({
      ok: true,
      draft: 'second',
      attempt: 2,
      verdict: 'flags',
      remarks: [{ code: 'STYLE_POOR', by: 'model' }],
      review: { kind: 'answered', model: 'openai/gpt-6-luna' },
    });
  });

  it('the redo fixes everything - verdict ok after the second attempt', async () => {
    const { llm } = fakeLlm(
      {
        [AUTHOR_STAGE]: [
          { json: { text: 'first' }, model: 'z-ai/glm-5.3' },
          { json: { text: 'second' }, model: 'z-ai/glm-5.3' },
        ],
        [REVIEW_STAGE]: [
          { json: styleRemark, model: 'openai/gpt-6-luna' },
          { json: ok, model: 'openai/gpt-6-luna' },
        ],
      },
      ['openai/gpt-6-luna'],
    );
    const result = await runQualityLoop(
      llm,
      'op',
      ctx,
      spec(() => [], []),
    );
    expect(result).toMatchObject({ ok: true, draft: 'second', attempt: 2, verdict: 'ok' });
  });

  it('the redo answered by a fallback of another family - the second reviewer is picked again against it', async () => {
    const { llm, calls } = fakeLlm(
      {
        [AUTHOR_STAGE]: [
          { json: { text: 'first' }, model: 'z-ai/glm-5.3' },
          { json: { text: 'second' }, model: 'openai/gpt-5.6-terra' },
        ],
        [REVIEW_STAGE]: [
          { json: styleRemark, model: 'openai/gpt-6-luna' },
          { json: ok, model: 'deepseek/deepseek-v4-pro' },
        ],
      },
      ['openai/gpt-6-luna', 'deepseek/deepseek-v4-pro'],
    );
    await runQualityLoop(
      llm,
      'op',
      ctx,
      spec(() => [], []),
    );
    expect(calls.map((c) => c.stage)).toEqual([
      AUTHOR_STAGE,
      REVIEW_STAGE,
      AUTHOR_STAGE,
      REVIEW_STAGE,
    ]);
    expect(calls[1]).toMatchObject({ model: 'openai/gpt-6-luna' });
    expect(calls[3]).toEqual({
      stage: REVIEW_STAGE,
      model: 'deepseek/deepseek-v4-pro',
      fallbacks: [],
    });
  });

  it('the author fell back to another family - the reviewer is picked against the model that answered', async () => {
    const { llm, calls } = fakeLlm(
      {
        [AUTHOR_STAGE]: [{ json: { text: 'clean' }, model: 'openai/gpt-5.6-terra' }],
        [REVIEW_STAGE]: [{ json: ok, model: 'deepseek/deepseek-v4-pro' }],
      },
      ['openai/gpt-6-luna', 'deepseek/deepseek-v4-pro'],
    );
    await runQualityLoop(
      llm,
      'op',
      ctx,
      spec(() => [], []),
    );
    expect(calls[1]).toEqual({
      stage: REVIEW_STAGE,
      model: 'deepseek/deepseek-v4-pro',
      fallbacks: [],
    });
  });

  it('the author of the first attempt answered GLM - the reviewer is the default of another family', async () => {
    const { llm, calls } = fakeLlm(
      {
        [AUTHOR_STAGE]: [{ json: { text: 'clean' }, model: 'z-ai/glm-5.3' }],
        [REVIEW_STAGE]: [{ json: ok, model: 'openai/gpt-6-luna' }],
      },
      ['openai/gpt-6-luna', 'deepseek/deepseek-v4-pro'],
    );
    await runQualityLoop(
      llm,
      'op',
      ctx,
      spec(() => [], []),
    );
    expect(calls[1]).toEqual({
      stage: REVIEW_STAGE,
      model: 'openai/gpt-6-luna',
      fallbacks: ['deepseek/deepseek-v4-pro'],
    });
  });

  it('the redo gives no text by the form - the first attempt stays with its remarks as flags', async () => {
    const { llm } = fakeLlm(
      {
        [AUTHOR_STAGE]: [
          { json: { text: 'first' }, model: 'z-ai/glm-5.3' },
          { json: { wrong: 1 }, model: 'z-ai/glm-5.3' },
          { json: { wrong: 2 }, model: 'z-ai/glm-5.3' },
        ],
        [REVIEW_STAGE]: [{ json: styleRemark, model: 'openai/gpt-6-luna' }],
      },
      ['openai/gpt-6-luna'],
    );
    const result = await runQualityLoop(
      llm,
      'op',
      ctx,
      spec(() => [], []),
    );
    expect(result).toMatchObject({ ok: true, draft: 'first', attempt: 1, verdict: 'flags' });
  });

  it('the first attempt gives no text by the form - not ok, no review', async () => {
    const { llm, calls } = fakeLlm(
      {
        [AUTHOR_STAGE]: [
          { json: { wrong: 1 }, model: 'z-ai/glm-5.3' },
          { json: { wrong: 2 }, model: 'z-ai/glm-5.3' },
        ],
        [REVIEW_STAGE]: [],
      },
      ['openai/gpt-6-luna'],
    );
    const result = await runQualityLoop(
      llm,
      'op',
      ctx,
      spec(() => [], []),
    );
    expect(result.ok).toBe(false);
    expect(calls.every((c) => c.stage === AUTHOR_STAGE)).toBe(true);
  });

  it('no reviewer of another family - no redo, not "ok", the review state says why', async () => {
    const { llm, calls } = fakeLlm(
      { [AUTHOR_STAGE]: [{ json: { text: 'clean' }, model: 'openai/gpt-5.6-terra' }] },
      ['openai/gpt-6-luna'],
    );
    const result = await runQualityLoop(
      llm,
      'op',
      ctx,
      spec(() => [], []),
    );
    expect(result).toMatchObject({
      ok: true,
      verdict: 'flags',
      remarks: [],
      review: { kind: 'not_independent' },
    });
    expect(calls).toHaveLength(1);
  });

  // Ни один исход без ответа проверяющей не даёт «годен» (решение арбитра `F06 | F06-1`, В5).
  it.each([
    ['too_long', [], false],
    [
      'invalid',
      [
        { json: { wrong: 1 }, model: 'openai/gpt-6-luna' },
        { json: { wrong: 2 }, model: 'openai/gpt-6-luna' },
      ],
      true,
    ],
    ['no_provider', [new LlmError('LLM_NO_COMPLIANT_PROVIDER', 'none')], true],
    ['unavailable', [new LlmError('LLM_STAGE_DISABLED', 'off')], true],
  ] as Array<[string, Reply[], boolean]>)(
    'the reviewer outcome %s - verdict flags, the review state names it',
    async (kind, reviewReplies, fits) => {
      const { llm } = fakeLlm(
        {
          [AUTHOR_STAGE]: [{ json: { text: 'clean' }, model: 'z-ai/glm-5.3' }],
          [REVIEW_STAGE]: reviewReplies,
        },
        ['openai/gpt-6-luna'],
        fits,
      );
      const result = await runQualityLoop(
        llm,
        'op',
        ctx,
        spec(() => [], []),
      );
      expect(result).toMatchObject({ ok: true, verdict: 'flags', remarks: [], review: { kind } });
    },
  );

  // Коды проверяющей - из спецификации цикла (решение арбитра `F07 | F07-1`, В2): проверяющая
  // анализа с кодом пересказа отбивается формой - ни переделки по нему, ни флага с ним.
  it('reviewCodes of the analysis: a reviewer answer with a summary code fails the form', async () => {
    const { llm, calls } = fakeLlm(
      {
        [AUTHOR_STAGE]: [{ json: { text: 'clean' }, model: 'z-ai/glm-5.3' }],
        [REVIEW_STAGE]: [
          {
            json: {
              verdict: 'remarks',
              remarks: [{ code: 'EVENT_MISSING', where: 'a', note: 'b' }],
            },
            model: 'openai/gpt-6-luna',
          },
          {
            json: {
              verdict: 'remarks',
              remarks: [{ code: 'EVENT_MISSING', where: 'a', note: 'b' }],
            },
            model: 'openai/gpt-6-luna',
          },
        ],
      },
      ['openai/gpt-6-luna'],
    );
    const result = await runQualityLoop(llm, 'op', ctx, {
      ...spec(() => [], []),
      reviewCodes: ['NOT_IN_TEXT', 'GENERIC'],
    });
    expect(result).toMatchObject({
      ok: true,
      attempt: 1,
      remarks: [],
      review: { kind: 'invalid' },
    });
    expect(calls.filter((c) => c.stage === AUTHOR_STAGE)).toHaveLength(1);
  });

  it('the default (no reviewCodes) is the summary set: an analysis code fails the form', async () => {
    const notInText = {
      verdict: 'remarks',
      remarks: [{ code: 'NOT_IN_TEXT', where: 'a', note: 'b' }],
    };
    const { llm, calls } = fakeLlm(
      {
        [AUTHOR_STAGE]: [{ json: { text: 'clean' }, model: 'z-ai/glm-5.3' }],
        [REVIEW_STAGE]: [
          { json: notInText, model: 'openai/gpt-6-luna' },
          { json: notInText, model: 'openai/gpt-6-luna' },
        ],
      },
      ['openai/gpt-6-luna'],
    );
    const result = await runQualityLoop(
      llm,
      'op',
      ctx,
      spec(() => [], []),
    );
    expect(result).toMatchObject({
      ok: true,
      attempt: 1,
      remarks: [],
      review: { kind: 'invalid' },
    });
    expect(calls.filter((c) => c.stage === AUTHOR_STAGE)).toHaveLength(1);
  });

  it('reviewCodes of the analysis: an analysis code passes the form and leads to the one redo', async () => {
    const notInText = {
      verdict: 'remarks',
      remarks: [{ code: 'NOT_IN_TEXT', where: 'themes.guilt.interpretation', note: 'no scene' }],
    };
    const { llm } = fakeLlm(
      {
        [AUTHOR_STAGE]: [
          { json: { text: 'first' }, model: 'z-ai/glm-5.3' },
          { json: { text: 'second' }, model: 'z-ai/glm-5.3' },
        ],
        [REVIEW_STAGE]: [
          { json: notInText, model: 'openai/gpt-6-luna' },
          { json: ok, model: 'openai/gpt-6-luna' },
        ],
      },
      ['openai/gpt-6-luna'],
    );
    const redos: Array<Redo<string> | null> = [];
    const result = await runQualityLoop(llm, 'op', ctx, {
      ...spec(() => [], redos),
      reviewCodes: ['NOT_IN_TEXT'],
    });
    expect(result).toMatchObject({ ok: true, draft: 'second', attempt: 2, verdict: 'ok' });
    expect(redos[1]?.remarks).toEqual([
      { code: 'NOT_IN_TEXT', where: 'themes.guilt.interpretation', note: 'no scene', by: 'model' },
    ]);
  });

  it('the cost sums every paid answer of both rounds, an invalid review included', async () => {
    const { llm } = fakeLlm(
      {
        [AUTHOR_STAGE]: [
          { json: { text: 'first' }, model: 'z-ai/glm-5.3' },
          { json: { text: 'second' }, model: 'z-ai/glm-5.3' },
        ],
        [REVIEW_STAGE]: [
          { json: styleRemark, model: 'openai/gpt-6-luna' },
          { json: { wrong: 1 }, model: 'openai/gpt-6-luna' },
          { json: { wrong: 2 }, model: 'openai/gpt-6-luna' },
        ],
      },
      ['openai/gpt-6-luna'],
    );
    const result = await runQualityLoop(
      llm,
      'op',
      ctx,
      spec(() => [], []),
    );
    expect(result).toMatchObject({ ok: true, attempt: 2, review: { kind: 'invalid' } });
    expect(result.costUsd.toString()).toBe('0.05');
  });

  it('the first round is handed over before the redo; a redo that throws leaves it saved', async () => {
    const pause = new LlmError('LLM_BUDGET_EXCEEDED', 'pause');
    const { llm } = fakeLlm(
      {
        [AUTHOR_STAGE]: [{ json: { text: 'first' }, model: 'z-ai/glm-5.3' }, pause],
        [REVIEW_STAGE]: [{ json: styleRemark, model: 'openai/gpt-6-luna' }],
      },
      ['openai/gpt-6-luna'],
    );
    const saved: unknown[] = [];
    const withSave = {
      ...spec(() => [], []),
      onBeforeRedo: (first: unknown) => {
        saved.push(first);
        return Promise.resolve();
      },
    };
    await expect(runQualityLoop(llm, 'op', ctx, withSave)).rejects.toBe(pause);
    expect(saved).toEqual([
      expect.objectContaining({ draft: 'first', attempt: 1, verdict: 'flags' }),
    ]);
  });

  it('no remarks - nothing is handed over before a redo that does not happen', async () => {
    const { llm } = fakeLlm(
      {
        [AUTHOR_STAGE]: [{ json: { text: 'clean' }, model: 'z-ai/glm-5.3' }],
        [REVIEW_STAGE]: [{ json: ok, model: 'openai/gpt-6-luna' }],
      },
      ['openai/gpt-6-luna'],
    );
    const onBeforeRedo = jest.fn(() => Promise.resolve());
    await runQualityLoop(llm, 'op', ctx, { ...spec(() => [], []), onBeforeRedo });
    expect(onBeforeRedo).not.toHaveBeenCalled();
  });

  it('the author is called with the models of the stage snapshot', async () => {
    const { llm, calls } = fakeLlm(
      {
        [AUTHOR_STAGE]: [{ json: { text: 'clean' }, model: 'z-ai/glm-5.3' }],
        [REVIEW_STAGE]: [{ json: ok, model: 'openai/gpt-6-luna' }],
      },
      ['openai/gpt-6-luna'],
    );
    await runQualityLoop(
      llm,
      'op',
      ctx,
      spec(() => [], []),
    );
    expect(calls[0]).toEqual({
      stage: AUTHOR_STAGE,
      model: 'z-ai/glm-5.3',
      fallbacks: ['openai/gpt-5.6-terra'],
    });
  });

  it('the paid author text is handed over before the review; a review that throws leaves it saved', async () => {
    const pause = new LlmError('LLM_BUDGET_EXCEEDED', 'pause');
    const { llm } = fakeLlm(
      {
        [AUTHOR_STAGE]: [{ json: { text: 'first' }, model: 'z-ai/glm-5.3' }],
        [REVIEW_STAGE]: [pause],
      },
      ['openai/gpt-6-luna'],
    );
    const authored: unknown[] = [];
    const withSave = {
      ...spec(() => [], []),
      onAuthored: (a: unknown) => {
        authored.push(a);
        return Promise.resolve();
      },
    };
    await expect(runQualityLoop(llm, 'op', ctx, withSave)).rejects.toBe(pause);
    expect(authored).toEqual([
      expect.objectContaining({ draft: 'first', attempt: 1, authorModel: 'z-ai/glm-5.3' }),
    ]);
  });

  it('a reviewer answer "ok" with remarks keeps the remarks; "remarks" with an empty list is ok', async () => {
    const okWithRemarks = { ...styleRemark, verdict: 'ok' };
    const remarksEmpty = { verdict: 'remarks', remarks: [] };
    const run = async (review: unknown) => {
      const { llm } = fakeLlm(
        {
          [AUTHOR_STAGE]: [
            { json: { text: 'first' }, model: 'z-ai/glm-5.3' },
            { json: { text: 'second' }, model: 'z-ai/glm-5.3' },
          ],
          [REVIEW_STAGE]: [
            { json: review, model: 'openai/gpt-6-luna' },
            { json: review, model: 'openai/gpt-6-luna' },
          ],
        },
        ['openai/gpt-6-luna'],
      );
      return runQualityLoop(
        llm,
        'op',
        ctx,
        spec(() => [], []),
      );
    };
    expect(await run(okWithRemarks)).toMatchObject({
      attempt: 2,
      verdict: 'flags',
      remarks: [{ code: 'STYLE_POOR' }],
    });
    expect(await run(remarksEmpty)).toMatchObject({ attempt: 1, verdict: 'ok', remarks: [] });
  });

  it('a redo without text by the form still counts its paid answers in the cost', async () => {
    const { llm } = fakeLlm(
      {
        [AUTHOR_STAGE]: [
          { json: { text: 'first' }, model: 'z-ai/glm-5.3' },
          { json: { wrong: 1 }, model: 'z-ai/glm-5.3' },
          { json: { wrong: 2 }, model: 'z-ai/glm-5.3' },
        ],
        [REVIEW_STAGE]: [{ json: styleRemark, model: 'openai/gpt-6-luna' }],
      },
      ['openai/gpt-6-luna'],
    );
    const result = await runQualityLoop(
      llm,
      'op',
      ctx,
      spec(() => [], []),
    );
    expect(result).toMatchObject({ ok: true, draft: 'first', attempt: 1 });
    expect(result.costUsd.toString()).toBe('0.04');
  });

  describe('resume after a break (F06 | F06-2, Р3)', () => {
    const authorCalls = (calls: Call[]) => calls.filter((c) => c.stage === AUTHOR_STAGE).length;

    it('a saved first text: no author call, the reviewer checks it, then one redo as usual', async () => {
      const { llm, calls } = fakeLlm(
        {
          [AUTHOR_STAGE]: [{ json: { text: 'fixed' }, model: 'z-ai/glm-5.3' }],
          [REVIEW_STAGE]: [
            { json: styleRemark, model: 'openai/gpt-6-luna' },
            { json: ok, model: 'openai/gpt-6-luna' },
          ],
        },
        ['openai/gpt-6-luna'],
      );
      const redos: Array<Redo<string> | null> = [];
      const result = await runQualityLoop(llm, 'op', ctx, {
        ...spec(() => [], redos),
        resume: { draft: 'saved', attempt: 1, authorModel: 'z-ai/glm-5.3' },
      });
      expect(result).toMatchObject({ ok: true, draft: 'fixed', attempt: 2, verdict: 'ok' });
      // Один вызов автора - переделка; первый текст не оплачен второй раз.
      expect(authorCalls(calls)).toBe(1);
      expect(redos).toEqual([
        { previous: 'saved', remarks: [expect.objectContaining({ code: 'STYLE_POOR' })] },
      ]);
    });

    it('a saved checked first text: straight to the redo, no second review of the first text', async () => {
      const { llm, calls } = fakeLlm(
        {
          [AUTHOR_STAGE]: [{ json: { text: 'fixed' }, model: 'z-ai/glm-5.3' }],
          [REVIEW_STAGE]: [{ json: ok, model: 'openai/gpt-6-luna' }],
        },
        ['openai/gpt-6-luna'],
      );
      const remarks = [codeRemark('LENGTH_OUT', '10 words', 'longer')];
      const result = await runQualityLoop(llm, 'op', ctx, {
        ...spec(() => [], []),
        resume: {
          draft: 'saved',
          attempt: 1,
          authorModel: 'z-ai/glm-5.3',
          checked: { remarks, review: { kind: 'answered', model: 'openai/gpt-6-luna' } },
        },
      });
      expect(result).toMatchObject({ ok: true, draft: 'fixed', attempt: 2 });
      expect(calls.map((c) => c.stage)).toEqual([AUTHOR_STAGE, REVIEW_STAGE]);
    });

    it('a saved redo: no author call at all, only the checks, no second redo', async () => {
      const { llm, calls } = fakeLlm(
        { [AUTHOR_STAGE]: [], [REVIEW_STAGE]: [{ json: styleRemark, model: 'openai/gpt-6-luna' }] },
        ['openai/gpt-6-luna'],
      );
      const result = await runQualityLoop(llm, 'op', ctx, {
        ...spec(() => [], []),
        resume: { draft: 'redone', attempt: 2, authorModel: 'z-ai/glm-5.3' },
      });
      expect(result).toMatchObject({ ok: true, draft: 'redone', attempt: 2, verdict: 'flags' });
      expect(authorCalls(calls)).toBe(0);
      expect(calls).toHaveLength(1);
      if (result.ok) expect(result.costUsd.toString()).toBe('0.01');
    });
  });
});

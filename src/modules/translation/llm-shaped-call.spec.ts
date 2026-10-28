import { Prisma } from '@prisma/client';
import { LlmError, LlmTruncatedError } from '../llm/llm.errors';
import { LlmService } from '../llm/llm.service';
import { LlmTaskContext } from '../llm-worker/llm-task.types';
import { Shape } from './dossier/dossier.format';
import { callShaped } from './llm-shaped-call';

const ctx = {
  signal: new AbortController().signal,
  renewLease: jest.fn(),
  callOptions: { beforeAttempt: jest.fn(), signal: new AbortController().signal, taskId: 't' },
} as unknown as LlmTaskContext;

const request = {
  messages: [{ role: 'user' as const, content: 'x' }],
  jsonSchema: { name: 'c', schema: {} },
};
const shape: Shape = { object: { verdict: { enum: ['pass'] } } };

const call = (llm: { callStage: jest.Mock }) =>
  callShaped(llm as unknown as LlmService, 'op', 'check_semantic', request, shape, ctx, {
    remarks: 1,
  });

describe('callShaped', () => {
  // Ответ проверяющей, оборванный лимитом на последней модели (`LEGACY-480`, решение арбитра
  // `F05 | F05-13d`): повтор с замечанием оборвался бы так же и оплатился заново.
  it('a cut-off answer refuses without a remark retry and keeps the paid cost', async () => {
    const llm = {
      callStage: jest
        .fn()
        .mockRejectedValue(new LlmTruncatedError('cut', new Prisma.Decimal('0.0475'))),
    };
    const result = await call(llm);
    expect(result).toEqual({ ok: false, costUsd: new Prisma.Decimal('0.0475') });
    expect(llm.callStage).toHaveBeenCalledTimes(1);
  });

  it('a cut-off answer after a paid remark retry keeps both costs', async () => {
    const llm = {
      callStage: jest
        .fn()
        .mockResolvedValueOnce({
          json: {},
          content: '{}',
          model: 'm/one',
          callId: 'call',
          costUsd: new Prisma.Decimal('0.01'),
        })
        .mockRejectedValueOnce(new LlmTruncatedError('cut', new Prisma.Decimal('0.04'))),
    };
    const result = await call(llm);
    expect(result).toEqual({ ok: false, costUsd: new Prisma.Decimal('0.05') });
    expect(llm.callStage).toHaveBeenCalledTimes(2);
  });

  // Запасная ответила разбираемым JSON не той формы после обрыва основной (решение арбитра
  // `F05 | F05-13d`): повтор с замечанием начал бы цепочку с оборванной модели.
  it('a wrong-shape answer after a cut-off refuses without a remark retry', async () => {
    const llm = {
      callStage: jest.fn().mockResolvedValue({
        json: { verdict: 'unsure' },
        content: '{"verdict":"unsure"}',
        model: 'm/two',
        callId: 'call',
        costUsd: new Prisma.Decimal('0.05'),
        afterTruncation: true,
      }),
    };
    const result = await call(llm);
    expect(result).toEqual({ ok: false, costUsd: new Prisma.Decimal('0.05') });
    expect(llm.callStage).toHaveBeenCalledTimes(1);
  });

  it('a right-shape answer after a cut-off is taken with both costs', async () => {
    const llm = {
      callStage: jest.fn().mockResolvedValue({
        json: { verdict: 'pass' },
        content: '{"verdict":"pass"}',
        model: 'm/two',
        callId: 'call',
        costUsd: new Prisma.Decimal('0.05'),
        afterTruncation: true,
      }),
    };
    const result = await call(llm);
    expect(result).toEqual({
      ok: true,
      value: { verdict: 'pass' },
      model: 'm/two',
      callId: 'call',
      costUsd: new Prisma.Decimal('0.05'),
    });
    expect(llm.callStage).toHaveBeenCalledTimes(1);
  });

  it('a wrong-shape answer without a cut-off still gets the remark retry', async () => {
    const llm = {
      callStage: jest.fn().mockResolvedValue({
        json: { verdict: 'unsure' },
        content: '{"verdict":"unsure"}',
        model: 'm/two',
        callId: 'call',
        costUsd: new Prisma.Decimal('0.01'),
      }),
    };
    const result = await call(llm);
    expect(result).toEqual({ ok: false, costUsd: new Prisma.Decimal('0.02') });
    expect(llm.callStage).toHaveBeenCalledTimes(2);
  });

  it('an ordinary invalid JSON still gets the remark retry', async () => {
    const llm = {
      callStage: jest.fn().mockRejectedValue(new LlmError('LLM_INVALID_RESPONSE', 'bad')),
    };
    const result = await call(llm);
    expect(result).toMatchObject({ ok: false });
    expect(llm.callStage).toHaveBeenCalledTimes(2);
    const remark = (llm.callStage.mock.calls[1][2] as Array<{ content: string }>).at(-1);
    expect(remark?.content).toContain('JSON only');
  });
});

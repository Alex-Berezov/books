import { NotFoundException } from '@nestjs/common';
import type { AnalysisWriteService } from '../analysis-write/analysis-write.service';
import type { SummaryWriteService } from '../summary-write/summary-write.service';
import { ContentDraftController } from './content-draft.controller';
import type { ContentDraftService } from './content-draft.service';

/**
 * Развилка общих ручек `content-drafts/:id/*` по виду строки (`F07-1b`, решение арбитра `F07 | F07-1`,
 * В6): пересказ идёт к сервису пересказа, как до `F07`; анализ - к своему; неизвестный вид - 404.
 */

type Kind = 'summary_write' | 'analysis_write';
const user = { user: { userId: 'u1' } };

function setup(kind: Kind | Error) {
  const methods = () => ({
    accept: jest.fn().mockResolvedValue({ via: 'x' }),
    discardItem: jest.fn().mockResolvedValue({ via: 'x' }),
    regenerate: jest.fn().mockResolvedValue({ via: 'x' }),
    discard: jest.fn().mockResolvedValue({ via: 'x' }),
    acceptAll: jest.fn().mockResolvedValue({ via: 'x' }),
    proposal: jest.fn().mockResolvedValue({ text: 'x' }),
  });
  const summary = methods();
  const analysis = methods();
  const drafts = {
    runKindOf:
      kind instanceof Error ? jest.fn().mockRejectedValue(kind) : jest.fn().mockResolvedValue(kind),
  };
  const controller = new ContentDraftController(
    drafts as unknown as ContentDraftService,
    summary as unknown as SummaryWriteService,
    analysis as unknown as AnalysisWriteService,
  );
  const calls = {
    accept: () => controller.accept('d1', 2, { confirmChapterChange: true }),
    discardItem: () => controller.discardItem('d1', 2),
    regenerate: () => controller.regenerate('d1', 2, { remark: 'shorter' }, user),
    discardRun: () => controller.discardRun('d1'),
    acceptAll: () => controller.acceptAll('d1'),
  };
  return { controller, summary, analysis, drafts, calls };
}

const ROUTES = [
  ['accept', 'accept'],
  ['discardItem', 'discardItem'],
  ['regenerate', 'regenerate'],
  ['discardRun', 'discard'],
  ['acceptAll', 'acceptAll'],
] as const;

describe('ContentDraftController: the fork by the kind of the run (F07-1b)', () => {
  it.each(ROUTES)(
    '%s of a summary run goes to the summary service, as before',
    async (route, method) => {
      const { summary, analysis, calls, drafts } = setup('summary_write');
      await calls[route]();
      expect(summary[method]).toHaveBeenCalledTimes(1);
      expect(analysis[method]).not.toHaveBeenCalled();
      expect(drafts.runKindOf).toHaveBeenCalledTimes(1);
    },
  );

  it.each(ROUTES)('%s of an analysis run goes to the analysis service', async (route, method) => {
    const { summary, analysis, calls } = setup('analysis_write');
    await calls[route]();
    expect(analysis[method]).toHaveBeenCalledTimes(1);
    expect(summary[method]).not.toHaveBeenCalled();
  });

  it('the arguments reach the service of the kind: the summary one gets the chapter confirmation, the remark and the user', async () => {
    const summary = setup('summary_write');
    await summary.calls.accept();
    await summary.calls.regenerate();
    expect(summary.summary.accept).toHaveBeenCalledTimes(1);
    expect(summary.summary.accept).toHaveBeenCalledWith('d1', 2, true);
    expect(summary.summary.regenerate).toHaveBeenCalledTimes(1);
    expect(summary.summary.regenerate).toHaveBeenCalledWith('d1', 2, 'shorter', 'u1');
    const analysis = setup('analysis_write');
    await analysis.calls.accept();
    await analysis.calls.regenerate();
    expect(analysis.analysis.accept).toHaveBeenCalledTimes(1);
    expect(analysis.analysis.accept).toHaveBeenCalledWith('d1', 2);
    expect(analysis.analysis.regenerate).toHaveBeenCalledTimes(1);
    expect(analysis.analysis.regenerate).toHaveBeenCalledWith('d1', 2, 'shorter', 'u1');
  });

  it.each(ROUTES)(
    '%s of an unknown or foreign kind is 404 and no service is touched',
    async (route, method) => {
      const { summary, analysis, calls } = setup(new NotFoundException('Run not found'));
      await expect(calls[route]()).rejects.toBeInstanceOf(NotFoundException);
      expect(summary[method]).not.toHaveBeenCalled();
      expect(analysis[method]).not.toHaveBeenCalled();
    },
  );
});

describe('GET content-drafts/:id/items/:index (F07-1b, decision А)', () => {
  it('goes straight to the analysis service: one read of the row there, the kind of the row decides 404 there', async () => {
    const { controller, analysis, summary, drafts } = setup('summary_write');
    await expect(controller.proposal('d1', 2)).resolves.toEqual({ text: 'x' });
    expect(analysis.proposal).toHaveBeenCalledTimes(1);
    expect(analysis.proposal).toHaveBeenCalledWith('d1', 2);
    expect(summary.proposal).not.toHaveBeenCalled();
    expect(drafts.runKindOf).not.toHaveBeenCalled();
  });
});

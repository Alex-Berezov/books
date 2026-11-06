import { Prisma } from '@prisma/client';
import { EMPTY_BOOK_ANALYSIS } from '../../book-analysis/book-analysis-data';
import { LlmService } from '../../llm/llm.service';
import { stageEstimatorFor } from '../llm-model-checks';
import { analysisUpperUsd } from './analysis-estimate';
import { analysisPipelineUsd } from './analysis-write.steps';

jest.mock('../llm-model-checks', () => ({ stageEstimatorFor: jest.fn() }));
jest.mock('./analysis-write.steps', () => ({ analysisPipelineUsd: jest.fn() }));

/**
 * Строки «Analysis» оценки запуска (`F07-3b`; решение арбитра `F07 | F07-3b`, В1): та же функция,
 * что у ручного старта, сверху - пустые блоки, без досье и глоссария, главы с текстом, название
 * и автор исходника, язык цели; вход общий с Summary и читается один раз на оценку.
 */
describe('analysisUpperUsd', () => {
  const llm = {} as LlmService;
  const source = (chapters: Array<{ number: number; title: string; content: string }>) => ({
    chapters,
    extra: 4000,
    title: 'Book',
    author: 'Author',
  });

  beforeEach(() => {
    jest.mocked(stageEstimatorFor).mockResolvedValue({} as never);
    jest.mocked(analysisPipelineUsd).mockReturnValue(new Prisma.Decimal('0.7'));
  });

  afterEach(() => jest.clearAllMocks());

  it('по языку - вход ручного старта сверху на исходнике; главы без текста отброшены', async () => {
    const chapters = [
      { number: 1, title: 'One', content: '<p>Text.</p>' },
      { number: 2, title: 'Empty', content: '<p> </p>' },
    ];

    const result = await analysisUpperUsd(llm, source(chapters), ['fr', 'es']);

    expect([...result.keys()]).toEqual(['fr', 'es']);
    expect(result.get('fr')?.toString()).toBe('0.7');
    // Оценщики этапов - один раз на оценку, а не на язык: шесть этапов хода.
    expect(stageEstimatorFor).toHaveBeenCalledTimes(6);
    expect(analysisPipelineUsd).toHaveBeenCalledTimes(2);
    expect(analysisPipelineUsd).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      {
        language: 'fr',
        dossier: null,
        glossary: null,
        bookTitle: 'Book',
        author: 'Author',
        stored: EMPTY_BOOK_ANALYSIS,
        merged: {},
        chapters: [chapters[0]],
        otherKeys: '',
      },
      4000,
    );
  });

  it('исходник без глав с текстом - пустой вход, а не отказ: цену даёт та же функция', async () => {
    const result = await analysisUpperUsd(llm, source([]), ['fr']);

    expect(result.get('fr')?.toString()).toBe('0.7');
    expect(analysisPipelineUsd).toHaveBeenCalledTimes(1);
    expect(analysisPipelineUsd).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ chapters: [] }),
      4000,
    );
  });
});

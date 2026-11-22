import { Prisma } from '@prisma/client';
import { BOOK_ANALYSIS_LIMITS } from '../../book-analysis/dto/book-analysis-blocks.dto';
import { LlmService } from '../../llm/llm.service';
import { stageEstimatorFor } from '../llm-model-checks';
import { hasWorldPairExample } from './examples';
import { upperWorldAnalysis, worldUpperUsd } from './world-estimate';
import { worldCharacters, worldPipelineUsd } from './world-write.steps';
import { WORLD_PAIRS_MAX } from './world-write.constants';

jest.mock('../llm-model-checks', () => ({ stageEstimatorFor: jest.fn() }));
jest.mock('./examples', () => ({
  ...jest.requireActual<object>('./examples'),
  hasWorldPairExample: jest.fn(),
}));
jest.mock('./world-write.steps', () => ({
  ...jest.requireActual<object>('./world-write.steps'),
  worldPipelineUsd: jest.fn(),
}));

/**
 * Строки «World» оценки запуска (`F08-9b`; решение арбитра `F08 | F08-9b`, Q5): та же функция, что
 * у ручного старта, сверху - анализ-подставка с пределом героев, все `main`, верхняя граница пар,
 * без досье и глоссария, главы с текстом, название и автор исходника, язык цели.
 */
describe('worldUpperUsd', () => {
  const llm = {} as LlmService;
  const source = (chapters: Array<{ number: number; title: string; content: string }>) => ({
    chapters,
    extra: 4000,
    title: 'Book',
    author: 'Author',
  });

  beforeEach(() => {
    jest.mocked(stageEstimatorFor).mockResolvedValue({} as never);
    jest.mocked(worldPipelineUsd).mockReturnValue(new Prisma.Decimal('0.9'));
    jest.mocked(hasWorldPairExample).mockReturnValue(true);
  });

  afterEach(() => jest.clearAllMocks());

  it('подставка анализа - предел героев анализа, все main и все идут в ход', () => {
    const analysis = upperWorldAnalysis();
    expect(analysis.characters).toHaveLength(BOOK_ANALYSIS_LIMITS.characters);
    expect(analysis.characters?.every((c) => c.role === 'main')).toBe(true);
    expect(worldCharacters(analysis)).toHaveLength(BOOK_ANALYSIS_LIMITS.characters);
  });

  it('по языку - вход ручного старта сверху на исходнике, пары - верхняя граница', async () => {
    const chapters = [
      { number: 1, title: 'One', content: '<p>Text.</p>' },
      { number: 2, title: 'Empty', content: '<p> </p>' },
    ];

    const result = await worldUpperUsd(llm, source(chapters), ['fr', 'es'], 'en');

    expect([...result.keys()]).toEqual(['fr', 'es']);
    expect(result.get('fr')?.toString()).toBe('0.9');
    // Оценщики этапов - один раз на оценку, а не на язык: пять этапов хода.
    expect(stageEstimatorFor).toHaveBeenCalledTimes(5);
    expect(worldPipelineUsd).toHaveBeenCalledTimes(2);
    expect(worldPipelineUsd).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      {
        language: 'fr',
        dossier: null,
        glossary: null,
        bookTitle: 'Book',
        author: 'Author',
        originalLanguage: 'en',
        chapters: [chapters[0]],
        analysis: upperWorldAnalysis(),
        entities: new Map(),
        names: { titles: ['Book'], authors: ['Author'] },
      },
      4000,
      WORLD_PAIRS_MAX,
      new Set(),
    );
  });

  it('язык без эталона пары - пар в оценке нет: шагов пар 0, а не верхняя граница', async () => {
    jest.mocked(hasWorldPairExample).mockImplementation((language) => language !== 'es');

    await worldUpperUsd(llm, source([]), ['fr', 'es'], 'en');

    expect(hasWorldPairExample).toHaveBeenCalledTimes(2);
    const pairs = jest.mocked(worldPipelineUsd).mock.calls.map((c) => [c[1].language, c[3]]);
    expect(pairs).toEqual([
      ['fr', WORLD_PAIRS_MAX],
      ['es', 0],
    ]);
  });
});

import { PrismaService } from '../../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { allChapters } from '../chapter-pages';
import { contextUpperChars } from '../translate/translate-estimate';
import { loadSectionUpperSource } from './section-upper-source';

jest.mock('../chapter-pages', () => ({ allChapters: jest.fn() }));
jest.mock('../translate/translate-estimate', () => ({ contextUpperChars: jest.fn() }));

/**
 * Общий вход строк Summary и Analysis оценки запуска (`F07-3b`; решение арбитра `F07 | F07-3b`, В1):
 * главы, потолок входа, название и автор исходника - одним чтением на оценку.
 */
describe('loadSectionUpperSource', () => {
  const llm = {} as LlmService;
  const findUnique = jest.fn();
  const db = { bookVersion: { findUnique } } as unknown as PrismaService;

  afterEach(() => jest.clearAllMocks());

  it('главы, потолок входа и название с автором исходника - по одному чтению', async () => {
    const chapters = [{ number: 1, title: 'One', content: '<p>Text.</p>' }];
    jest.mocked(allChapters).mockResolvedValue(chapters as never);
    jest.mocked(contextUpperChars).mockResolvedValue(4000);
    findUnique.mockResolvedValue({ title: 'Book', author: 'Author' });

    await expect(loadSectionUpperSource(llm, db, 'v-en')).resolves.toEqual({
      chapters,
      extra: 4000,
      title: 'Book',
      author: 'Author',
    });
    expect(allChapters).toHaveBeenCalledTimes(1);
    expect(allChapters).toHaveBeenCalledWith(db, 'v-en', {
      number: true,
      title: true,
      content: true,
    });
    expect(contextUpperChars).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('версии нет - пустые название и автор, а не отказ', async () => {
    jest.mocked(allChapters).mockResolvedValue([] as never);
    jest.mocked(contextUpperChars).mockResolvedValue(0);
    findUnique.mockResolvedValue(null);

    await expect(loadSectionUpperSource(llm, db, 'v-en')).resolves.toMatchObject({
      title: '',
      author: '',
    });
  });
});

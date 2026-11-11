import type { ContentDraft } from '@prisma/client';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { SourceFetcherService } from '../../source-fetch/source-fetcher.service';
import type { LlmService } from '../../llm/llm.service';
import type { LlmTaskService } from '../../llm-worker/llm-task.service';
import type { ContentDraftService } from '../content-draft/content-draft.service';
import type { DossierDemandService } from '../dossier/dossier-demand.service';
import { emptyAnalysisData } from './analysis-write.data';
import type { AnalysisWriteFields } from './analysis-write.fields';
import { AnalysisWriteHandler } from './analysis-write.handler';

jest.mock('../chapter-pages', () => ({ allChapters: jest.fn().mockResolvedValue([]) }));
jest.mock('./analysis-keys', () => ({ otherLanguageKeys: jest.fn().mockResolvedValue('') }));

type VersionRow = { title: string; author: string; originalTitle: string | null };

/**
 * Контекст шага (`contextOf`, `T182`): оригинальные названия версий книги идут в
 * `originalTitles` - их в кавычках толкования код не считает цитатой, - но не в `names.titles`,
 * которыми страница источника шага 5 подтверждает, что она про эту книгу.
 */
describe('AnalysisWriteHandler.contextOf - original titles (T182)', () => {
  function handlerWith(version: VersionRow, versions: VersionRow[]) {
    const db = {
      bookVersion: {
        findUnique: jest.fn().mockResolvedValue({ ...version, originalLanguage: 'en' }),
        findMany: jest.fn().mockResolvedValue(versions),
      },
      bookGlossary: { findUnique: jest.fn() },
    };
    const fields = { state: jest.fn().mockResolvedValue({ stored: {} }) };
    const handler = new AnalysisWriteHandler(
      db as unknown as PrismaService,
      {} as LlmService,
      {} as LlmTaskService,
      {} as DossierDemandService,
      {} as ContentDraftService,
      fields as unknown as AnalysisWriteFields,
      {} as SourceFetcherService,
    );
    return { handler, db };
  }

  const row = { bookVersionId: 'v1', language: 'ru', glossaryId: null } as unknown as ContentDraft;

  it('collects non-empty original titles of all versions once; titles of the source check stay without them', async () => {
    const { handler, db } = handlerWith(
      // Оригинальное название текущей версии есть только у неё: его отдаёт findUnique.
      { title: 'Шум и ярость', author: 'Фолкнер', originalTitle: 'The Sound and the Fury' },
      [
        { title: 'Шум и ярость', author: 'Фолкнер', originalTitle: null },
        {
          title: 'El ruido y la furia',
          author: 'Faulkner',
          originalTitle: 'The Sound and the Fury',
        },
        { title: 'Le Bruit et la Fureur', author: 'Faulkner', originalTitle: 'Sound and Fury' },
        { title: 'Il rumore', author: 'Faulkner', originalTitle: '' },
      ],
    );
    const context = await handler.contextOf(row, {}, emptyAnalysisData({}, {}));
    expect(context.originalTitles).toEqual(['The Sound and the Fury', 'Sound and Fury']);
    expect(context.names?.titles).toEqual([
      'Шум и ярость',
      'El ruido y la furia',
      'Le Bruit et la Fureur',
      'Il rumore',
    ]);
    expect(db.bookVersion.findUnique).toHaveBeenCalledTimes(1);
    expect(db.bookVersion.findUnique).toHaveBeenCalledWith({
      where: { id: 'v1' },
      select: { title: true, author: true, originalLanguage: true, originalTitle: true },
    });
    expect(db.bookVersion.findMany).toHaveBeenCalledTimes(1);
    expect(db.bookVersion.findMany).toHaveBeenCalledWith({
      where: { book: { versions: { some: { id: 'v1' } } } },
      select: { title: true, author: true, originalTitle: true },
      take: 10,
    });
  });

  it('the original title of the current version alone still reaches originalTitles', async () => {
    const { handler } = handlerWith(
      { title: 'Шум и ярость', author: 'Фолкнер', originalTitle: 'The Sound and the Fury' },
      [],
    );
    const context = await handler.contextOf(row, {}, emptyAnalysisData({}, {}));
    expect(context.originalTitles).toEqual(['The Sound and the Fury']);
  });
});

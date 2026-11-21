import { Prisma } from '@prisma/client';
import { emptyWorldData } from './world-write.data';
import { WorldWriteService } from './world-write.service';

describe('WorldWriteService: the regeneration estimate of a pair (F08-8e-4 Q1-bis)', () => {
  const hero = (key: string, chapters: number[]) => ({
    key,
    role: 'main' as const,
    name: key.toUpperCase(),
    aliases: [],
    mentions: { chapters, perChapter: {} },
  });
  const context = {
    language: 'en',
    dossier: null,
    glossary: null,
    bookTitle: 'B',
    author: 'A',
    originalLanguage: '',
    entities: new Map(),
    chapters: [
      { number: 1, title: 'C1', content: '<p>Anna maps the road.</p>' },
      { number: 2, title: 'C2', content: '<p>Boris rings the bell.</p>' },
    ],
    analysis: { characters: [] },
    names: { titles: ['B'], authors: ['A'] },
  };

  it('a pair not linked and without shared chapters: the estimate counts the chapters of both heroes', async () => {
    const estimate = jest.fn().mockReturnValue(new Prisma.Decimal(0));
    const llm = {
      stageCallEstimator: jest.fn().mockResolvedValue({ enabled: true, maxTokens: 0, estimate }),
    };
    const service = new WorldWriteService(
      { bookDossier: { findUnique: jest.fn().mockResolvedValue({ data: {} }) } } as never,
      llm as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { contextOf: jest.fn().mockResolvedValue(context) } as never,
    );
    const data = {
      ...emptyWorldData(),
      candidates: [hero('anna', [1]), hero('boris', [2])],
      pairs: [{ key: 'anna--boris', a: 'anna', b: 'boris', linked: false, chapters: [] }],
    };
    await (service as unknown as { regenUsd: (...a: unknown[]) => Promise<unknown> }).regenUsd(
      { id: 'd1', dossierId: 'dos1' },
      data,
      { key: 'anna--boris', block: 'bonds', value: null, step: 5 },
      null,
    );
    const sent = JSON.stringify(estimate.mock.calls as unknown[]);
    expect(sent).toContain('Anna maps the road.');
    expect(sent).toContain('Boris rings the bell.');
  });
});

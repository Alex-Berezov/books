import { Language, Prisma } from '@prisma/client';
import { lockBookLanguages } from './book-language-lock';

describe('lockBookLanguages (Р6)', () => {
  it('locks each language once and in sorted order: crossing starts do not deadlock', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ locked: true }]);
    const tx = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;

    await lockBookLanguages(tx, 'b1', [Language.ru, Language.es, Language.fr, Language.es]);

    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(queryRaw.mock.calls.map((call: unknown[]) => call[2])).toEqual([
      'b1:es',
      'b1:fr',
      'b1:ru',
    ]);
  });
});

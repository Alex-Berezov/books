import { Language, Prisma, PublicationStatus } from '@prisma/client';
import { targetVersionState, versionHasContent } from './target-version-text';

/** Главы версии по номеру; `findMany` отвечает так, как отвечает база на запрос `chapterPages`. */
function chaptersDb(contents: string[]) {
  const rows = contents.map((content, i) => ({ number: i + 1, content }));
  const findMany = jest.fn(
    ({ where, take }: { where: { number: { gt?: number }; content?: unknown }; take: number }) => {
      const after = where.number.gt ?? 0;
      const nonEmpty = where.content !== undefined;
      return Promise.resolve(
        rows.filter((r) => r.number > after && (!nonEmpty || r.content !== '')).slice(0, take),
      );
    },
  );
  return { db: { chapter: { findMany } } as unknown as Prisma.TransactionClient, findMany };
}

const version = (over: Partial<{ status: PublicationStatus; nonEmpty: number }> = {}) => ({
  id: 'v-es',
  language: Language.es,
  status: over.status ?? PublicationStatus.draft,
  _count: { chapters: over.nonEmpty ?? 1 },
});

describe('versionHasContent (D9, Е и круг 1 п.2)', () => {
  it('content found past the first page: the cursor goes on until a chapter with text', async () => {
    const { db, findMany } = chaptersDb([...Array<string>(25).fill('<p> </p>'), '<p>Texto</p>']);
    await expect(versionHasContent(db, 'v-es')).resolves.toBe(true);
    expect(findMany).toHaveBeenCalledTimes(3);
  });

  it('only empty HTML and blanks: no content, every page read once', async () => {
    const { db, findMany } = chaptersDb([...Array<string>(12).fill('<p></p>'), '']);
    await expect(versionHasContent(db, 'v-es')).resolves.toBe(false);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('a chapter of one picture is content', async () => {
    const { db } = chaptersDb(['<p><img src="https://example.com/i.jpg"></p>']);
    await expect(versionHasContent(db, 'v-es')).resolves.toBe(true);
  });
});

describe('targetVersionState (D9, Е и круг 1 п.3)', () => {
  it('outside the intake, published or without non-empty chapters - no read', async () => {
    const { db, findMany } = chaptersDb(['<p>Texto</p>']);
    expect(await targetVersionState(db, version(), ['fr'])).toEqual({
      status: PublicationStatus.draft,
      hasContent: false,
    });
    expect(
      await targetVersionState(db, version({ status: PublicationStatus.published }), ['es']),
    ).toEqual({ status: PublicationStatus.published, hasContent: false });
    expect(await targetVersionState(db, version({ nonEmpty: 0 }), ['es'])).toEqual({
      status: PublicationStatus.draft,
      hasContent: false,
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('in the intake, or without the intake filter (attach) - the text is read', async () => {
    const { db, findMany } = chaptersDb(['<p>Texto</p>']);
    expect((await targetVersionState(db, version(), ['es'])).hasContent).toBe(true);
    expect((await targetVersionState(db, version())).hasContent).toBe(true);
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});

import { PrismaService } from '../../../prisma/prisma.service';
import { hasVisibleText, savedFull, sectionChapters, summaryPlanOf } from './summary-sources';

describe('summary run sources (F06-2, moved in F06-3)', () => {
  it('summaryPlanOf: plan entries of the right form only', () => {
    expect(
      summaryPlanOf({
        summaryPlan: [
          { number: 1, title: 'Chapter 1', chapters: [1, 'x', 2], why: '' },
          { number: 'two', title: 'Bad', chapters: [] },
          { number: 3, title: 7, chapters: [3] },
          { number: 4, title: 'No chapters', chapters: 'all' },
          null,
        ],
      }),
    ).toEqual([{ number: 1, title: 'Chapter 1', chapters: [1, 2] }]);
    expect(summaryPlanOf(null)).toEqual([]);
    expect(summaryPlanOf({ summaryPlan: 'none' })).toEqual([]);
  });

  it('hasVisibleText: an image or empty tags are not text', () => {
    expect(hasVisibleText('<p>Text.</p>')).toBe(true);
    expect(hasVisibleText('<p>&nbsp;</p><figure><img src="a.jpg"></figure>')).toBe(false);
    expect(hasVisibleText(null)).toBe(false);
  });

  it('savedFull: the summary of the version as paragraphs; empty or none - null', async () => {
    const findUnique = jest.fn().mockResolvedValue({ summary: '<h2>Part</h2><p>Anna.</p>' });
    const prisma = { bookSummary: { findUnique } } as unknown as PrismaService;
    await expect(savedFull(prisma, 'v1')).resolves.toBe('## Part\n\nAnna.');
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({
      where: { bookVersionId: 'v1' },
      select: { summary: true },
    });
    findUnique.mockResolvedValueOnce({ summary: '<p></p>' });
    await expect(savedFull(prisma, 'v1')).resolves.toBeNull();
    findUnique.mockResolvedValueOnce(null);
    await expect(savedFull(prisma, 'v1')).resolves.toBeNull();
  });

  it('sectionChapters: chapters of the plan section of this version, in order, bounded', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = { chapter: { findMany } } as unknown as PrismaService;
    await sectionChapters(prisma, 'v1', { chapters: [2, 3] });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { bookVersionId: 'v1', number: { in: [2, 3] } },
      select: { number: true, title: true, content: true },
      orderBy: { number: 'asc' },
      take: 2,
    });
  });
});

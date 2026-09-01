import { Logger } from '@nestjs/common';
import { Language } from '@prisma/client';
import { SystemPagesService } from './system-pages.service';
import {
  SYSTEM_PAGES_CHECK_FAILED_RU,
  SYSTEM_PAGE_KEYS,
  SYSTEM_PAGE_LANGUAGES,
} from './system-pages.constants';
import { PrismaService } from '../../../prisma/prisma.service';

type Row = { systemKey: string | null; slug: string; language: Language; status: string };

const everythingPublished = (): Row[] =>
  SYSTEM_PAGE_KEYS.flatMap(({ key }) =>
    SYSTEM_PAGE_LANGUAGES.map((language) => ({
      systemKey: key,
      slug: `${key}-index`,
      language,
      status: 'published',
    })),
  );

const prismaWith = (rows: Row[] | Error) =>
  ({
    page: {
      findMany: jest.fn(() =>
        rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows),
      ),
    },
  }) as unknown as PrismaService;

describe('SystemPagesService', () => {
  it('is quiet when every system key is published in every language', async () => {
    const status = await new SystemPagesService(prismaWith(everythingPublished())).check();

    expect(status.ok).toBe(true);
    expect(status.problems).toHaveLength(0);
    expect(status.pages).toHaveLength(SYSTEM_PAGE_KEYS.length);
  });

  /**
   * 🔴 The production incident, replayed against the new contract: the title
   * "Homepage" regenerated the slug, `homepage-index` stopped existing and
   * `homepage` appeared in its place. That used to sever the lookup and cost the
   * homepage its editorial content.
   *
   * Since A2 the site resolves by `systemKey`, so the very same rename must now
   * be a non-event. This test fails if anything routes back through the slug.
   */
  it('stays quiet when the slug is renamed, because the key did not move', async () => {
    const rows = everythingPublished().map((r) =>
      r.systemKey === 'homepage' ? { ...r, slug: 'homepage' } : r,
    );

    const status = await new SystemPagesService(prismaWith(rows)).check();

    expect(status.ok).toBe(true);
    expect(status.problems).toHaveLength(0);
  });

  /**
   * The failure the key cannot prevent: a page created without a key at all —
   * a fresh language added after the backfill, or a row the backfill missed
   * because its slug had already drifted.
   */
  it('reports a page that carries no system key', async () => {
    const rows = everythingPublished().map((r) =>
      r.systemKey === 'homepage' && r.language === Language.ru ? { ...r, systemKey: null } : r,
    );

    const status = await new SystemPagesService(prismaWith(rows)).check();

    expect(status.ok).toBe(false);
    expect(status.problems.map((p) => p.systemKey)).toEqual(['homepage']);
    expect(status.problems[0].missingIn).toEqual([Language.ru]);
  });

  it('reports a hub that is missing in one language only', async () => {
    const rows = everythingPublished().filter(
      (r) => !(r.systemKey === 'taxonomy-tags' && r.language === Language.fr),
    );

    const status = await new SystemPagesService(prismaWith(rows)).check();

    expect(status.ok).toBe(false);
    expect(status.problems.map((p) => p.systemKey)).toEqual(['taxonomy-tags']);
    expect(status.problems[0].missingIn).toEqual([Language.fr]);
  });

  /** A draft page is not served publicly, so it is a problem, not a pass. */
  it('counts an unpublished page as unresolved and says it is a draft', async () => {
    const rows = everythingPublished().map((r) =>
      r.systemKey === 'taxonomy-genres' && r.language === Language.ru
        ? { ...r, status: 'draft' }
        : r,
    );

    const status = await new SystemPagesService(prismaWith(rows)).check();

    expect(status.ok).toBe(false);
    expect(status.problems[0].draftIn).toEqual([Language.ru]);
    expect(status.problems[0].missingIn).toHaveLength(0);
  });

  /** The report names the public URL too — the key alone does not locate the page for a human. */
  it('reports the current slug of each language alongside the key', async () => {
    const status = await new SystemPagesService(prismaWith(everythingPublished())).check();

    const homepage = status.pages.find((p) => p.systemKey === 'homepage');
    expect(homepage?.slugs[Language.en]).toBe('homepage-index');
  });

  /**
   * "Could not check" is not "fine" — the same rule the live SEO audit follows.
   *
   * ⚠️ `LEGACY-197`. Прежнее утверждение было `expect(status.error).toContain('db down')`,
   * то есть спека **закрепляла утечку**: текст исключения Prisma уезжал в тело
   * ответа 200. Утверждение не снято, а развёрнуто: текста драйвера в поле нет,
   * поле равно именованной константе, а сам текст ушёл в журнал со стеком.
   * Фикстура (`new Error('db down')`) та же.
   */
  it('does not report a pass when the query itself failed', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const status = await new SystemPagesService(prismaWith(new Error('db down'))).check();

    expect(status.ok).toBe(false);
    expect(status.error).not.toContain('db down');
    expect(status.error).toBe(SYSTEM_PAGES_CHECK_FAILED_RU);
    expect(status.problems).toHaveLength(0);

    // Диагностика не потеряна: раньше поле `error` было её единственным каналом.
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0][1])).toContain('db down');
    logged.mockRestore();
  });

  it('logs every unresolved page at startup instead of failing silently', async () => {
    const rows = everythingPublished().filter((r) => r.systemKey !== 'taxonomy-collections');
    const service = new SystemPagesService(prismaWith(rows));
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await service.onApplicationBootstrap();

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('taxonomy-collections');
    error.mockRestore();
  });

  it('does not crash the application when the check cannot run at startup', async () => {
    const service = new SystemPagesService(prismaWith(new Error('db down')));
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    // Две записи, и обе нужны: причина со стеком пишется внутри `check()`
    // (`LEGACY-197`), отметка «старт прошёл без проверки» — здесь.
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[0][1])).toContain('db down');
    expect(String(error.mock.calls[1][0])).toContain('did not run at startup');
    // Текст драйвера не дублируется в строке про старт — иначе он снова
    // расползётся по каналам, из которых его только что убрали.
    expect(String(error.mock.calls[1][0])).not.toContain('db down');
    error.mockRestore();
  });
});

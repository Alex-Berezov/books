import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Language } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  SYSTEM_PAGES_CHECK_FAILED_RU,
  SYSTEM_PAGE_KEYS,
  SYSTEM_PAGE_LANGUAGES,
  type SystemPageKey,
} from './system-pages.constants';

export interface SystemPageState {
  systemKey: SystemPageKey;
  purpose: string;
  publishedIn: Language[];
  draftIn: Language[];
  missingIn: Language[];
  /**
   * What the page is called publicly right now, per language. Purely for the
   * human reading the report — the key is what the site resolves by, and a slug
   * that differs between languages is normal, not a fault.
   */
  slugs: Partial<Record<Language, string>>;
}

export interface SystemPagesStatus {
  ok: boolean;
  checkedAt: string;
  expectedLanguages: Language[];
  /** Every system page, healthy or not — the full picture for a human. */
  pages: SystemPageState[];
  /** Only what is wrong. Empty on a healthy site; this is what alerts read. */
  problems: SystemPageState[];
  /** Set when the check itself could not run. "Unknown" is not "fine". */
  error?: string;
}

/**
 * Verifies that every key the public site resolves by actually lands on a
 * published page in every language.
 *
 * Runs once at startup and on demand via `GET /admin/seo/system-pages/status`.
 *
 * It was written as a detector for a slug that carried a functional contract;
 * since 09.08.2026 the contract lives in `Page.systemKey`, which an editor
 * cannot touch, so the failure mode it was built for is closed. It still earns
 * its place: a system page can be unpublished, deleted, or created in a new
 * language and never backfilled, and each of those is invisible from the
 * outside — the hub keeps answering 200 with fallback text.
 */
@Injectable()
export class SystemPagesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SystemPagesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    const status = await this.check();

    if (status.error) {
      // A database hiccup during boot must not take the app down, but it must
      // not read as a pass either. Причина уже записана внутри `check()`
      // вместе со стеком — здесь остаётся только отметка, что старт прошёл
      // без проверки (`LEGACY-197`).
      this.logger.error(`System page check did not run at startup (${status.checkedAt})`);
      return;
    }

    if (status.ok) {
      this.logger.log(
        `System pages OK — ${SYSTEM_PAGE_KEYS.length} keys published in ${SYSTEM_PAGE_LANGUAGES.length} languages`,
      );
      return;
    }

    for (const page of status.problems) {
      this.logger.error(
        `SYSTEM PAGE UNRESOLVED: "${page.systemKey}" (${page.purpose}) — ` +
          `missing in [${page.missingIn.join(', ') || '-'}]` +
          (page.draftIn.length ? `, still draft in [${page.draftIn.join(', ')}]` : '') +
          '. The page is served from fallback text and its SEO content is gone.',
      );
    }
  }

  async check(): Promise<SystemPagesStatus> {
    const checkedAt = new Date().toISOString();
    const keys = SYSTEM_PAGE_KEYS.map((p) => p.key);

    let rows: Array<{ systemKey: string | null; slug: string; language: Language; status: string }>;
    try {
      rows = await this.prisma.page.findMany({
        where: { systemKey: { in: keys } },
        select: { systemKey: true, slug: true, language: true, status: true },
      });
    } catch (error) {
      // Текст исключения остаётся здесь и дальше журнала не идёт (`LEGACY-197`).
      // Логирование заведено прямо в `catch`, а не в `onApplicationBootstrap`:
      // раньше единственным каналом диагностики было само поле `error`, и,
      // убрав из него текст, отказ потеряли бы совсем.
      this.logger.error(
        `System page check could not run at ${checkedAt}`,
        error instanceof Error ? error.stack : String(error),
      );
      return {
        ok: false,
        checkedAt,
        expectedLanguages: SYSTEM_PAGE_LANGUAGES,
        pages: [],
        problems: [],
        error: SYSTEM_PAGES_CHECK_FAILED_RU,
      };
    }

    const pages: SystemPageState[] = SYSTEM_PAGE_KEYS.map(({ key, purpose }) => {
      const forKey = rows.filter((r) => r.systemKey === key);
      const publishedIn = forKey.filter((r) => r.status === 'published').map((r) => r.language);
      const draftIn = forKey.filter((r) => r.status !== 'published').map((r) => r.language);
      const missingIn = SYSTEM_PAGE_LANGUAGES.filter(
        (lang) => !publishedIn.includes(lang) && !draftIn.includes(lang),
      );
      const slugs: Partial<Record<Language, string>> = {};
      for (const row of forKey) slugs[row.language] = row.slug;

      return { systemKey: key, purpose, publishedIn, draftIn, missingIn, slugs };
    });

    const problems = pages.filter((p) => p.missingIn.length > 0 || p.draftIn.length > 0);

    return {
      ok: problems.length === 0,
      checkedAt,
      expectedLanguages: SYSTEM_PAGE_LANGUAGES,
      pages,
      problems,
    };
  }
}

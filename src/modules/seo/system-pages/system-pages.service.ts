import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Language } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { SYSTEM_PAGE_LANGUAGES, SYSTEM_PAGE_SLUGS } from './system-pages.constants';

export interface SystemPageState {
  slug: string;
  purpose: string;
  publishedIn: Language[];
  draftIn: Language[];
  missingIn: Language[];
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
 * Verifies that every slug the public site hard-codes actually resolves.
 *
 * Runs once at startup and on demand via
 * `GET /admin/seo/system-pages/status`. It is a detector, not a fix: the slug
 * remains an editable field carrying a functional contract until §A2 replaces
 * it with an immutable key. What it buys is that the failure stops being
 * indistinguishable from normal operation.
 */
@Injectable()
export class SystemPagesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SystemPagesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    const status = await this.check();

    if (status.error) {
      // A database hiccup during boot must not take the app down, but it must
      // not read as a pass either.
      this.logger.error(`System page check could not run: ${status.error}`);
      return;
    }

    if (status.ok) {
      this.logger.log(
        `System pages OK — ${SYSTEM_PAGE_SLUGS.length} slugs published in ${SYSTEM_PAGE_LANGUAGES.length} languages`,
      );
      return;
    }

    for (const page of status.problems) {
      this.logger.error(
        `SYSTEM PAGE UNRESOLVED: "${page.slug}" (${page.purpose}) — ` +
          `missing in [${page.missingIn.join(', ') || '-'}]` +
          (page.draftIn.length ? `, still draft in [${page.draftIn.join(', ')}]` : '') +
          '. The page is served from fallback text and its SEO content is gone.',
      );
    }
  }

  async check(): Promise<SystemPagesStatus> {
    const checkedAt = new Date().toISOString();
    const slugs = SYSTEM_PAGE_SLUGS.map((p) => p.slug);

    let rows: Array<{ slug: string; language: Language; status: string }>;
    try {
      rows = await this.prisma.page.findMany({
        where: { slug: { in: slugs } },
        select: { slug: true, language: true, status: true },
      });
    } catch (error) {
      return {
        ok: false,
        checkedAt,
        expectedLanguages: SYSTEM_PAGE_LANGUAGES,
        pages: [],
        problems: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const pages: SystemPageState[] = SYSTEM_PAGE_SLUGS.map(({ slug, purpose }) => {
      const forSlug = rows.filter((r) => r.slug === slug);
      const publishedIn = forSlug.filter((r) => r.status === 'published').map((r) => r.language);
      const draftIn = forSlug.filter((r) => r.status !== 'published').map((r) => r.language);
      const missingIn = SYSTEM_PAGE_LANGUAGES.filter(
        (lang) => !publishedIn.includes(lang) && !draftIn.includes(lang),
      );
      return { slug, purpose, publishedIn, draftIn, missingIn };
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

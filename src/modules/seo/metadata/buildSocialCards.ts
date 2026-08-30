import { Seo } from '@prisma/client';

export interface SocialCardsInput {
  /** Ручная запись SEO, если она есть: любое её поле перебивает выведенное. */
  seo: Seo | null;
  metaTitle: string;
  metaDescription?: string;
  canonicalUrl: string;
  /** `book` — у страницы книги и версии, `website` — у остальных. */
  ogType: 'website' | 'book';
  /** Обложка. Берётся, только если в записи SEO не задана своя картинка. */
  coverImageUrl?: string | null;
}

export interface SocialCards {
  openGraph: {
    title: string;
    description?: string;
    type: 'website' | 'book';
    url: string;
    image?: { url: string; alt: string };
  };
  twitter: {
    card: string;
    site?: string;
    creator?: string;
    image?: string;
  };
}

/**
 * Собрать блоки Open Graph и Twitter публичного SEO-ответа.
 *
 * 🔴 `LEGACY-317`. До 30.08.2026 эти шесть строк стояли в `seo.service.ts`
 * четырежды дословно — в сборщике термина и в ветках `version`, `book`, `page`.
 * Ни компилятор, ни линт расхождения копий не видели, и оно уже случалось:
 * `LEGACY-305` поставила метку деградации в двух местах из четырёх.
 *
 * ⚠️ Правило `twitterCard` неочевидно и повторению не подлежит: карточка
 * становится большой не от типа страницы, а от наличия картинки, причём
 * картинки уже вычисленной — то есть с учётом обложки. Именно поэтому обложка
 * приходит сюда параметром, а не подставляется вызывающим заранее.
 */
export function buildSocialCards({
  seo,
  metaTitle,
  metaDescription,
  canonicalUrl,
  ogType,
  coverImageUrl,
}: SocialCardsInput): SocialCards {
  const ogImageUrl = seo?.ogImageUrl || coverImageUrl || undefined;
  const ogImageAlt = seo?.ogImageAlt || metaTitle;

  return {
    openGraph: {
      title: seo?.ogTitle || metaTitle,
      description: seo?.ogDescription || metaDescription,
      type: ogType,
      url: seo?.ogUrl || canonicalUrl,
      image: ogImageUrl ? { url: ogImageUrl, alt: ogImageAlt } : undefined,
    },
    twitter: {
      card: seo?.twitterCard || (ogImageUrl ? 'summary_large_image' : 'summary'),
      site: seo?.twitterSite || undefined,
      creator: seo?.twitterCreator || undefined,
      image: ogImageUrl || undefined,
    },
  };
}

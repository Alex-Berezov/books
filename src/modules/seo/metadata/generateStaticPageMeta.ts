import { stripHtml } from '../utils/stripHtml';
import { truncateMeta } from '../utils/truncateMeta';

export interface StaticPageMetaData {
  title: string;
  content: string;
  language: string;
}

export function generateStaticPageMeta(data: StaticPageMetaData): {
  title: string;
  description: string;
} {
  const { title, content } = data;
  const cleanContent = stripHtml(content);

  const metaTitle = `${title} | Bibliaris`;
  const metaDesc = cleanContent
    ? truncateMeta(cleanContent, 160)
    : `Read ${title} on Bibliaris. Free classic literature and audiobooks online.`;

  return {
    title: truncateMeta(metaTitle, 65),
    description: truncateMeta(metaDesc, 160),
  };
}

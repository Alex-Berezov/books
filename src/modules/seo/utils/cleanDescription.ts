import { PrismaClient } from '@prisma/client';

export function getEditorialFallbackDescription(
  title: string,
  author: string,
  language: string,
): string {
  const lang = language.toLowerCase();
  switch (lang) {
    case 'ru':
      return `«${title}» — знаменитое произведение автора ${author}. На Bibliaris вы можете читать книгу онлайн бесплатно, слушать аудиокнигу, изучить краткое содержание, персонажей, ключевые темы и цитаты.`;
    case 'es':
      return `«${title}» es una obra famosa de ${author}. En Bibliaris puedes leer el libro en línea gratis, escuchar el audiolibro, explorar un resumen corto, personajes, temas y citas.`;
    case 'pt':
      return `«${title}» é uma obra famosa de ${author}. No Bibliaris você pode ler o livro online gratuitamente, ouvir o audiolibro, explorar um resumo curto, personagens, temas e citações.`;
    case 'fr':
      return `«${title}» est une œuvre célèbre de ${author}. Sur Bibliaris, vous pouvez lire le livre gratuitement en ligne, écouter le livre audio, explorer un résumé court, les personnages, les thèmes et les citations.`;
    case 'en':
    default:
      return `«${title}» is a famous work by ${author}. On Bibliaris, readers can read the book online for free, listen to the audiobook, explore a short summary, characters, themes, and quotes.`;
  }
}

export async function cleanDescription(
  prisma: PrismaClient,
  versionId: string,
  title: string,
  author: string,
  language: string,
  dbDescription: string | null | undefined,
): Promise<string> {
  const desc = (dbDescription || '').trim();
  if (!desc) {
    return getEditorialFallbackDescription(title, author, language);
  }

  try {
    const firstChapter = await prisma.chapter.findFirst({
      where: { bookVersionId: versionId },
      orderBy: { number: 'asc' },
      select: { content: true },
    });

    if (firstChapter && firstChapter.content) {
      // Strip HTML tags and normalize whitespace
      const stripHtml = (text: string) =>
        text
          .replace(/<[^>]*>/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      const cleanChapter = stripHtml(firstChapter.content);
      const cleanDesc = stripHtml(desc);

      // If description matches the start of the first chapter (or vice-versa), use the editorial fallback
      if (
        cleanDesc.length > 10 &&
        (cleanChapter.startsWith(cleanDesc.substring(0, 50)) ||
          cleanDesc.startsWith(cleanChapter.substring(0, 50)))
      ) {
        return getEditorialFallbackDescription(title, author, language);
      }
    }
  } catch {
    // Ignore errors, return default description
  }

  return desc;
}

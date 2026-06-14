import { stripHtml } from '../utils/stripHtml';
import { truncateMeta } from '../utils/truncateMeta';

export interface AuthorMetaData {
  name: string;
  biography?: string | null;
  language: string;
}

export function generateAuthorMeta(data: AuthorMetaData): { title: string; description: string } {
  const { name, biography, language } = data;
  const lang = language.toLowerCase();

  let metaTitle = '';
  let metaDesc = '';

  switch (lang) {
    case 'ru':
      metaTitle = `${name} — Книги, биография и цитаты | Bibliaris`;
      metaDesc = biography
        ? truncateMeta(stripHtml(biography), 160)
        : `Откройте для себя книги, биографию, цитаты и классические произведения автора ${name} на Bibliaris. Читайте и слушайте онлайн бесплатно.`;
      break;
    case 'es':
      metaTitle = `${name} - Libros, biografía y frases | Bibliaris`;
      metaDesc = biography
        ? truncateMeta(stripHtml(biography), 160)
        : `Explora libros, biografía, frases y obras clásicas de ${name} en Bibliaris. Lee y escucha en línea gratis.`;
      break;
    case 'pt':
      metaTitle = `${name} - Livros, biografia e frases | Bibliaris`;
      metaDesc = biography
        ? truncateMeta(stripHtml(biography), 160)
        : `Explore livros, biografia, frases e obras clássicas de ${name} no Bibliaris. Leia e ouça online gratuitamente.`;
      break;
    case 'fr':
      metaTitle = `${name} - Livres, biographie et citations | Bibliaris`;
      metaDesc = biography
        ? truncateMeta(stripHtml(biography), 160)
        : `Découvrez les livres, la biographie, les citations et les œuvres classiques de ${name} sur Bibliaris. Lisez et écoutez gratuitement en ligne.`;
      break;
    case 'en':
    default:
      metaTitle = `${name} - Books, Biography & Quotes | Bibliaris`;
      metaDesc = biography
        ? truncateMeta(stripHtml(biography), 160)
        : `Explore books, biography, quotes, and classic works by ${name} on Bibliaris. Read and listen online for free.`;
      break;
  }

  return {
    title: truncateMeta(metaTitle, 65),
    description: truncateMeta(metaDesc, 160),
  };
}

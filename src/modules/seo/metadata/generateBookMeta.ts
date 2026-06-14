import { stripHtml } from '../utils/stripHtml';
import { truncateMeta } from '../utils/truncateMeta';

export interface BookMetaData {
  title: string;
  author: string;
  description?: string | null;
  language: string;
}

export function generateBookMeta(data: BookMetaData): { title: string; description: string } {
  const { title, author, description, language } = data;
  const lang = language.toLowerCase();

  let metaTitle = '';
  let metaDesc = '';

  switch (lang) {
    case 'ru':
      metaTitle = `${title} — ${author} | Читать и слушать бесплатно`;
      metaDesc = description
        ? truncateMeta(stripHtml(description), 160)
        : `Читайте «${title}» ${author} онлайн бесплатно. Слушайте аудиокнигу, смотрите краткое содержание, персонажей, темы и главы на Bibliaris.`;
      break;
    case 'es':
      metaTitle = `${title} de ${author} | Leer y escuchar gratis`;
      metaDesc = description
        ? truncateMeta(stripHtml(description), 160)
        : `Lee ${title} de ${author} gratis en línea. Escucha el audiolibro, lee un resumen corto, explora personajes, temas, citas y capítulos en Bibliaris.`;
      break;
    case 'pt':
      metaTitle = `${title} de ${author} | Ler e ouvir grátis`;
      metaDesc = description
        ? truncateMeta(stripHtml(description), 160)
        : `Leia ${title} de ${author} online gratuitamente. Ouça o audiolibro, leia um resumo curto, explore personagens, temas, citações e capítulos no Bibliaris.`;
      break;
    case 'fr':
      metaTitle = `${title} de ${author} | Lire et écouter gratuit`;
      metaDesc = description
        ? truncateMeta(stripHtml(description), 160)
        : `Lisez ${title} de ${author} gratuitement en ligne. Écoutez le livre audio, lisez un résumé court, explorez les personnages, les thèmes, les citations et les chapitres sur Bibliaris.`;
      break;
    case 'en':
    default:
      metaTitle = `${title} by ${author} | Read & Listen Free | Bibliaris`;
      metaDesc = description
        ? truncateMeta(stripHtml(description), 160)
        : `Read ${title} by ${author} online for free. Listen to the audiobook, read a short summary, explore characters, themes, quotes, and chapters on Bibliaris.`;
      break;
  }

  return {
    title: truncateMeta(metaTitle, 65),
    description: truncateMeta(metaDesc, 160),
  };
}

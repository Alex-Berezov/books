import { stripHtml } from '../utils/stripHtml';
import { truncateMeta } from '../utils/truncateMeta';

export interface GenreMetaData {
  name: string;
  description?: string | null;
  language: string;
}

export function generateGenreMeta(data: GenreMetaData): { title: string; description: string } {
  const { name, description, language } = data;
  const lang = language.toLowerCase();

  let metaTitle = '';
  let metaDesc = '';

  switch (lang) {
    case 'ru':
      metaTitle = `${name} — Книги читать и слушать онлайн | Bibliaris`;
      metaDesc = description
        ? truncateMeta(stripHtml(description), 160)
        : `Читайте и слушайте лучшие книги в жанре «${name}» онлайн бесплатно. Откройте для себя популярные новинки, краткие содержания и авторов на Bibliaris.`;
      break;
    case 'es':
      metaTitle = `Libros de ${name} - Leer y escuchar en línea | Bibliaris`;
      metaDesc = description
        ? truncateMeta(stripHtml(description), 160)
        : `Lee y escucha los mejores libros de ${name} gratis en línea. Explora novedades, resúmenes populares y autores en este género en Bibliaris.`;
      break;
    case 'pt':
      metaTitle = `Livros de ${name} - Ler e ouvir online | Bibliaris`;
      metaDesc = description
        ? truncateMeta(stripHtml(description), 160)
        : `Leia e ouça os melhores livros de ${name} online gratuitamente. Explore novidades, resumos populares e autores deste gênero no Bibliaris.`;
      break;
    case 'fr':
      metaTitle = `Livres de ${name} - Lire et écouter en ligne | Bibliaris`;
      metaDesc = description
        ? truncateMeta(stripHtml(description), 160)
        : `Lisez et écoutez les meilleurs livres de ${name} gratuitement en ligne. Découvrez les nouveautés, les résumés populaires et les auteurs de ce genre sur Bibliaris.`;
      break;
    case 'en':
    default:
      metaTitle = `${name} Books - Read & Listen Online | Bibliaris`;
      metaDesc = description
        ? truncateMeta(stripHtml(description), 160)
        : `Read and listen to the best ${name} books online for free. Explore popular and new releases, summaries, and authors in this genre on Bibliaris.`;
      break;
  }

  return {
    title: truncateMeta(metaTitle, 65),
    description: truncateMeta(metaDesc, 160),
  };
}

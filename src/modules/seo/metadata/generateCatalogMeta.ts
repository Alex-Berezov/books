import { truncateMeta } from '../utils/truncateMeta';

export interface CatalogMetaData {
  language: string;
}

export function generateCatalogMeta(data: CatalogMetaData): { title: string; description: string } {
  const lang = data.language.toLowerCase();

  let metaTitle = '';
  let metaDesc = '';

  switch (lang) {
    case 'ru':
      metaTitle = 'Каталог книг — читать и слушать бесплатно | Bibliaris';
      metaDesc =
        'Просмотрите полный каталог книг на Bibliaris. Откройте для себя классическую литературу, аудиокниги, краткие содержания, популярные жанры и новинки.';
      break;
    case 'es':
      metaTitle = 'Catálogo completo de libros - Leer y escuchar gratis | Bibliaris';
      metaDesc =
        'Explora nuestro catálogo completo de libros en Bibliaris. Descubre literatura clásica, audiolibros, resúmenes, géneros populares y novedades.';
      break;
    case 'pt':
      metaTitle = 'Catálogo completo de livros - Ler e ouvir grátis | Bibliaris';
      metaDesc =
        'Explore nosso catálogo completo de livros no Bibliaris. Descubra literatura clássica, audiolibros, resumos, gêneros populares e lançamentos.';
      break;
    case 'fr':
      metaTitle = 'Catalogue complet de livres - Lire et écouter gratuit | Bibliaris';
      metaDesc =
        'Découvrez notre catalogue complet de livres sur Bibliaris. Explorez la littérature classique, les livres audio, les résumés, les genres populaires et les nouveautés.';
      break;
    case 'en':
    default:
      metaTitle = 'All Books Catalog - Read & Listen Free | Bibliaris';
      metaDesc =
        'Browse our full catalog of books on Bibliaris. Explore classic literature, audiobooks, summaries, popular genres, and new releases.';
      break;
  }

  return {
    title: truncateMeta(metaTitle, 65),
    description: truncateMeta(metaDesc, 160),
  };
}

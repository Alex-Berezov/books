import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

// Simple Cyrillic transliteration map
const cyrillicToLatin: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'yo',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

function slugify(text: string): string {
  let s = text.toLowerCase().trim();
  s = s
    .split('')
    .map((char) => cyrillicToLatin[char] ?? char)
    .join('');
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/[^a-z0-9]+/g, '-');
  return s.replace(/^-+|-+$/g, '').replace(/-+/g, '-');
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('Fetching book versions from DB...');
  const versions = await prisma.bookVersion.findMany({
    select: { id: true, title: true, language: true, slug: true },
  });

  console.log(`Found ${versions.length} book versions.`);
  let updatedCount = 0;

  for (const v of versions) {
    if (!v.slug) {
      const generatedSlug = slugify(v.title);
      console.log(
        `Generating slug for version [${v.id}] (${v.language}): "${v.title}" -> "${generatedSlug}"`,
      );

      // Ensure uniqueness within the language
      let uniqueSlug = generatedSlug;
      let suffix = 1;
      while (true) {
        const conflict = await prisma.bookVersion.findFirst({
          where: { language: v.language, slug: uniqueSlug, NOT: { id: v.id } },
        });
        if (!conflict) break;
        uniqueSlug = `${generatedSlug}-${suffix}`;
        suffix++;
      }

      await prisma.bookVersion.update({
        where: { id: v.id },
        data: { slug: uniqueSlug },
      });
      updatedCount++;
    }
  }

  console.log(`Successfully updated ${updatedCount} book versions with slugs.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });

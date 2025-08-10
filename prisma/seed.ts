import { PrismaClient, Language, BookType, CategoryType } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Seed Categories
  const categories = await prisma.$transaction([
    prisma.category.upsert({
      where: { slug: 'fantasy' },
      update: {},
      create: { slug: 'fantasy', name: 'Fantasy', type: CategoryType.genre },
    }),
    prisma.category.upsert({
      where: { slug: 'bestsellers' },
      update: {},
      create: { slug: 'bestsellers', name: 'Bestsellers', type: CategoryType.popular },
    }),
  ]);

  // Seed Book with Version
  const book = await prisma.book.upsert({
    where: { slug: 'harry-potter' },
    update: {},
    create: {
      slug: 'harry-potter',
      versions: {
        create: [
          {
            language: Language.en,
            title: "Harry Potter and the Philosopher's Stone",
            author: 'J.K. Rowling',
            description: 'First book of the Harry Potter series',
            coverImageUrl: 'https://example.com/harry.jpg',
            type: BookType.text,
            isFree: true,
          },
        ],
      },
    },
    include: { versions: true },
  });

  const firstVersion = book.versions[0];
  if (!firstVersion) throw new Error('Book version was not created');

  // Attach categories to book version (idempotent)
  for (const cat of categories) {
    const exists = await prisma.bookCategory.findFirst({
      where: { bookVersionId: firstVersion.id, categoryId: cat.id },
      select: { id: true },
    });
    if (!exists) {
      await prisma.bookCategory.create({
        data: { bookVersionId: firstVersion.id, categoryId: cat.id },
      });
    }
  }

  console.log('Seeded categories and a sample book with version');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });

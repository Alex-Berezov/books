import { PrismaClient, Language, BookType, CategoryType, RoleName } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Seed Roles
  await prisma.$transaction([
    prisma.role.upsert({
      where: { name: RoleName.user },
      update: {},
      create: { name: RoleName.user },
    }),
    prisma.role.upsert({
      where: { name: RoleName.admin },
      update: {},
      create: { name: RoleName.admin },
    }),
    prisma.role.upsert({
      where: { name: RoleName.content_manager },
      update: {},
      create: { name: RoleName.content_manager },
    }),
  ]);

  // Optionally map env emails to roles (idempotent)
  const addRoleForEmails = async (emailsCsv: string | undefined, roleName: RoleName) => {
    const emails = (emailsCsv || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    if (emails.length === 0) return;
    const role = await prisma.role.findUnique({ where: { name: roleName }, select: { id: true } });
    if (!role?.id) return;
    for (const email of emails) {
      const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (user?.id) {
        const exists = await prisma.userRole.findUnique({
          where: { userId_roleId: { userId: user.id, roleId: role.id } },
          select: { userId: true },
        });
        if (!exists) {
          await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
        }
      }
    }
  };

  await addRoleForEmails(process.env.ADMIN_EMAILS, RoleName.admin);
  await addRoleForEmails(process.env.CONTENT_MANAGER_EMAILS, RoleName.content_manager);
  // Seed Categories (slug is not unique anymore => no upsert by slug)
  const getOrCreateCategory = async (
    slug: string,
    name: string,
    type: CategoryType,
  ): Promise<{ id: string; slug: string; name: string }> => {
    const existing = await prisma.category.findFirst({ where: { slug } });
    if (existing) return existing;
    return prisma.category.create({ data: { slug, name, type } });
  };

  const categories = await Promise.all([
    getOrCreateCategory('fantasy', 'Fantasy', CategoryType.genre),
    getOrCreateCategory('bestsellers', 'Bestsellers', CategoryType.popular),
  ]);

  // Ensure default translations for seeded categories (idempotent)
  for (const cat of categories) {
    const existing = await prisma.categoryTranslation.findUnique({
      where: { categoryId_language: { categoryId: cat.id, language: Language.en } },
    });
    if (!existing) {
      await prisma.categoryTranslation.create({
        data: {
          categoryId: cat.id,
          language: Language.en,
          name: cat.name,
          slug: cat.slug,
        },
      });
    }
  }

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

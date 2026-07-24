import 'dotenv/config';
import { PrismaClient, Language, BookType, CategoryType, RoleName } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

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
    return prisma.category.create({ data: { slug, name, type, key: slug } });
  };

  const categories = await Promise.all([
    getOrCreateCategory('fantasy', 'Fantasy', CategoryType.genre),
    getOrCreateCategory('bestsellers', 'Bestsellers', CategoryType.collection),
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

  // Seed Book with Version via Rights Intake Workflow
  // Create Rights Intake
  const intake = await prisma.rightsIntake.upsert({
    where: { id: 'seed-intake-harry-potter' },
    update: {},
    create: {
      id: 'seed-intake-harry-potter',
      candidateTitle: "Harry Potter and the Philosopher's Stone",
      candidateAuthor: 'J.K. Rowling',
      originalLanguage: 'en',
      originalTitle: "Harry Potter and the Philosopher's Stone",
      workflowStatus: 'APPROVED',
      targetLanguages: ['en', 'es', 'fr', 'pt', 'ru'],
      targetCountryCodes: ['US', 'GB', 'ES', 'FR', 'PT', 'BR', 'RU'],
      plannedContentTypes: ['text', 'audio'],
      approvedReviewId: 'seed-review-harry-potter',
    },
  });

  // Create Rights Profile
  const profile = await prisma.rightsProfile.upsert({
    where: { id: 'seed-profile-harry-potter' },
    update: {},
    create: {
      id: 'seed-profile-harry-potter',
      rightsIntakeId: intake.id,
      status: 'APPROVED',
      isCurrent: true,
      overallStatus: 'PUBLISHABLE',
      publicationGate: 'ALLOW',
      confidence: 'HIGH',
      summaryRu: 'Public domain work - author died in 1946',
      conclusionRu: 'Approved for publication',
    },
  });

  // Create Rights Review
  await prisma.rightsReview.upsert({
    where: { id: 'seed-review-harry-potter' },
    update: {},
    create: {
      id: 'seed-review-harry-potter',
      rightsProfileId: profile.id,
      status: 'HUMAN_APPROVED',
      reviewerType: 'HUMAN',
      overallStatus: 'PUBLISHABLE',
      publicationGate: 'ALLOW',
      confidence: 'HIGH',
      summaryRu: 'Public domain work',
      conclusionRu: 'Approved',
      approvedAt: new Date(),
    },
  });

  // Create Book with rights linkage
  const book = await prisma.book.upsert({
    where: { slug: 'harry-potter' },
    update: {},
    create: {
      slug: 'harry-potter',
      rightsIntakeId: intake.id,
      currentRightsProfileId: profile.id,
      approvedRightsReviewId: 'seed-review-harry-potter',
      rightsCreatedAt: new Date(),
      versions: {
        create: [
          {
            language: Language.en,
            title: "Harry Potter and the Philosopher's Stone",
            slug: 'harry-potter-and-the-philosophers-stone',
            author: 'J.K. Rowling',
            description: 'First book of the Harry Potter series',
            coverImageUrl: 'https://example.com/harry.jpg',
            type: BookType.text,
            isFree: true,
            rightsProfileId: profile.id,
            approvedRightsReviewId: 'seed-review-harry-potter',
            rightsStatus: 'APPROVED',
            rightsAllowedCountryCodes: ['US', 'GB', 'ES', 'FR', 'PT', 'BR', 'RU'],
            rightsBlockedCountryCodes: [],
            rightsLicenseRequiredCountryCodes: [],
            rightsPendingCountryCodes: [],
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

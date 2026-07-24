import { PrismaClient, Language } from '@prisma/client';

export interface BookWithRights {
  book: {
    id: string;
    slug: string;
    rightsIntakeId: string | null;
    currentRightsProfileId: string | null;
    approvedRightsReviewId: string | null;
  };
  intake: { id: string };
  profile: { id: string };
  review: { id: string };
}

export async function createBookWithRights(
  prisma: PrismaClient,
  slug: string,
  options: {
    title?: string;
    author?: string;
    languages?: Language[];
  } = {},
): Promise<BookWithRights> {
  const { title = 'Test Book', author = 'Test Author', languages = [Language.en] } = options;

  const intakeId = `test-intake-${slug}`;
  const profileId = `test-profile-${slug}`;
  const reviewId = `test-review-${slug}`;

  // Create Rights Intake
  const intake = await prisma.rightsIntake.create({
    data: {
      id: intakeId,
      candidateTitle: title,
      candidateAuthor: author,
      originalLanguage: 'en',
      originalTitle: title,
      workflowStatus: 'APPROVED',
      targetLanguages: languages,
      targetCountryCodes: ['US', 'GB'],
      plannedContentTypes: ['text'],
      approvedReviewId: reviewId,
    },
  });

  // Create Rights Profile
  const profile = await prisma.rightsProfile.create({
    data: {
      id: profileId,
      rightsIntakeId: intake.id,
      status: 'APPROVED',
      isCurrent: true,
      overallStatus: 'PUBLISHABLE',
      publicationGate: 'ALLOW',
      confidence: 'HIGH',
      summaryRu: 'Test rights profile',
      conclusionRu: 'Approved for testing',
    },
  });

  // Create Rights Review
  const review = await prisma.rightsReview.create({
    data: {
      id: reviewId,
      rightsProfileId: profile.id,
      status: 'HUMAN_APPROVED',
      reviewerType: 'HUMAN',
      overallStatus: 'PUBLISHABLE',
      publicationGate: 'ALLOW',
      confidence: 'HIGH',
      summaryRu: 'Test review',
      conclusionRu: 'Approved',
      approvedAt: new Date(),
    },
  });

  // Create Book with rights linkage
  const book = await prisma.book.create({
    data: {
      slug,
      rightsIntakeId: intake.id,
      currentRightsProfileId: profile.id,
      approvedRightsReviewId: review.id,
      rightsCreatedAt: new Date(),
    },
  });

  return {
    book: {
      id: book.id,
      slug: book.slug,
      rightsIntakeId: book.rightsIntakeId,
      currentRightsProfileId: book.currentRightsProfileId,
      approvedRightsReviewId: book.approvedRightsReviewId,
    },
    intake: { id: intake.id },
    profile: { id: profile.id },
    review: { id: review.id },
  };
}

export async function cleanupBookWithRights(prisma: PrismaClient, slug: string): Promise<void> {
  const intakeId = `test-intake-${slug}`;
  const profileId = `test-profile-${slug}`;
  const reviewId = `test-review-${slug}`;

  // Delete in correct order to respect foreign keys
  await prisma.bookVersion.deleteMany({ where: { book: { slug } } });
  await prisma.book.delete({ where: { slug } }).catch(() => {});
  await prisma.rightsReview.delete({ where: { id: reviewId } }).catch(() => {});
  await prisma.rightsProfile.delete({ where: { id: profileId } }).catch(() => {});
  await prisma.rightsIntake.delete({ where: { id: intakeId } }).catch(() => {});
}

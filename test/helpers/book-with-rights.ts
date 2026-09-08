import { PrismaClient, Language } from '@prisma/client';
import { createBookFixture } from './book-fixture';

const DEFAULT_RIGHTS_TARGET_LANGUAGES: Language[] = [
  Language.en,
  Language.es,
  Language.fr,
  Language.pt,
  Language.ru,
];

/**
 * Слаг, под которым заведена фикстура, → id её цепочки прав (`LEGACY-200`).
 * Заполняется `createBookWithRights`, читается `cleanupBookWithRights`: с уходом
 * литеральных id это единственный способ вычистить цепочку, когда книги под этим
 * слагом уже нет — удалена посадкой или переименована ею.
 */
const fixtureRightsIds = new Map<
  string,
  { intakeId: string; profileId: string; reviewId: string; reviewImportId: string }
>();

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
  reviewImport: { id: string };
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
  const {
    title = 'Test Book',
    author = 'Test Author',
    languages = DEFAULT_RIGHTS_TARGET_LANGUAGES,
  } = options;

  // LEGACY-200: id этих четырёх записей больше не задаётся литералом - слаг остаётся только
  // в тексте фикстуры (`candidateTitle`), а связи держатся через `.id`, полученные от Prisma.
  // Порядок создания - по зависимостям: `RightsIntake.approvedReviewId` ссылается на ревью,
  // которого в момент создания intake ещё нет, разрыв цикла закрывается финальным `update`.

  // Create Rights Intake
  const intake = await prisma.rightsIntake.create({
    data: {
      candidateTitle: title,
      candidateAuthor: author,
      originalLanguage: 'en',
      originalTitle: title,
      workflowStatus: 'APPROVED',
      targetLanguages: languages,
      targetCountryCodes: ['US', 'GB'],
      plannedContentTypes: ['text'],
    },
  });

  // Create Rights Profile
  const profile = await prisma.rightsProfile.create({
    data: {
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

  // Языковой клиренс профиля: гейт публикации требует реальной оценки на язык версии
  // (`MISSING_LANGUAGE_RIGHTS_ASSESSMENT`), поэтому фикстура покрывает все целевые языки.
  await prisma.sourceEdition.create({
    data: {
      rightsProfileId: profile.id,
      provider: 'UNKNOWN',
      sourceTextType: 'ORIGINAL_TEXT',
      status: 'ALLOWED',
      editionRights: {
        create: languages.map((languageCode) => ({
          languageCode,
          status: 'ALLOWED',
          translationOrigin: 'NOT_APPLICABLE_ORIGINAL',
        })),
      },
    },
  });

  // Create Rights Review Import (required by RightsReview)
  const reviewImport = await prisma.rightsReviewImport.create({
    data: {
      rightsIntakeId: intake.id,
      importStatus: 'VALIDATED',
      isCurrent: true,
      reportJson: { source: 'test-helper' },
    },
  });

  // Create Rights Review
  const review = await prisma.rightsReview.create({
    data: {
      rightsProfileId: profile.id,
      rightsReviewImportId: reviewImport.id,
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

  await prisma.rightsIntake.update({
    where: { id: intake.id },
    data: { approvedReviewId: review.id },
  });

  // Create Book with rights linkage.
  // Запись в `Book` идёт через единственную точку шортката (`LEGACY-039`): сама связка прав
  // здесь настоящая, но путь создания книги по-прежнему обходит клиренс, и обход обязан быть
  // виден в одном месте, а не расползаться по фикстурам.
  const book = await createBookFixture(prisma, slug, {
    rightsIntakeId: intake.id,
    currentRightsProfileId: profile.id,
    approvedRightsReviewId: review.id,
    rightsCreatedAt: new Date(),
  });

  fixtureRightsIds.set(slug, {
    intakeId: intake.id,
    profileId: profile.id,
    reviewId: review.id,
    reviewImportId: reviewImport.id,
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
    reviewImport: { id: reviewImport.id },
  };
}

export async function cleanupBookWithRights(prisma: PrismaClient, slug: string): Promise<void> {
  // 🔴 `LEGACY-200`. Источник id — реестр фикстуры, а **не** строка `Book`. До 08.09.2026
  // id выводились из слага литералом (`test-intake-<slug>`), и чистка работала независимо
  // от того, жива ли книга. Чтение связей с книги вернуло бы «успех, ничего не удалено»
  // сразу в двух живых случаях: книгу уже удалили до вызова чистки и слаг книге меняла
  // сама посадка (`test/slug-redirect.e2e-spec.ts:76-79` делает оба). Молчаливый пропуск
  // копил бы по цепочке прав на каждую фикстуру за прогон.
  //
  // Книга — только запасной путь: реестр живёт в памяти процесса, а спека заводит
  // и чистит фикстуру внутри одного файла (`maxWorkers: 2`, файлы внутри воркера идут
  // последовательно в одном процессе).
  const known = fixtureRightsIds.get(slug);
  const book = known
    ? null
    : await prisma.book.findUnique({
        where: { slug },
        select: {
          rightsIntakeId: true,
          currentRightsProfileId: true,
          approvedRightsReviewId: true,
        },
      });

  const intakeId = known?.intakeId ?? book?.rightsIntakeId ?? null;
  const profileId = known?.profileId ?? book?.currentRightsProfileId ?? null;
  const reviewId = known?.reviewId ?? book?.approvedRightsReviewId ?? null;
  const reviewImportId =
    known?.reviewImportId ??
    (reviewId
      ? (
          await prisma.rightsReview.findUnique({
            where: { id: reviewId },
            select: { rightsReviewImportId: true },
          })
        )?.rightsReviewImportId
      : null) ??
    null;

  // Delete in correct order to respect foreign keys
  await prisma.bookVersion.deleteMany({ where: { book: { slug } } });
  await prisma.book.deleteMany({ where: { slug } });
  if (reviewId) await prisma.rightsReview.deleteMany({ where: { id: reviewId } });
  if (reviewImportId) {
    await prisma.rightsReviewImport.deleteMany({ where: { id: reviewImportId } });
  }
  if (profileId) await prisma.rightsProfile.deleteMany({ where: { id: profileId } });
  if (intakeId) await prisma.rightsIntake.deleteMany({ where: { id: intakeId } });

  fixtureRightsIds.delete(slug);
}

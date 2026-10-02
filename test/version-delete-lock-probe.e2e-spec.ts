import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { BookType, ContributorRole, Language, Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AdminAuditService } from '../src/shared/admin-audit/admin-audit.service';
import { AudioChapterService } from '../src/modules/audio-chapter/audio-chapter.service';
import { BookService } from '../src/modules/book/book.service';
import { BookVersionService } from '../src/modules/book-version/book-version.service';
import { ChapterService } from '../src/modules/chapter/chapter.service';
import { RightsClearanceLockService } from '../src/modules/rights-intake/rights-clearance-lock.service';
import { RightsContentHashService } from '../src/modules/rights-intake/rights-content-hash.service';
import { ContributorRole as DtoContributorRole } from '../src/modules/persons/person-interface';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';
import { backendPid, waitBlockedBy } from './helpers/lock-probe';

/**
 * 🔴 `LEGACY-431`, пачка `T78`. Живая проба: удаление версии (`BookVersionService.remove`) и удаление
 * книги (`BookService.remove`) идут мимо замка группы прав, а 12 писателей версии — через него
 * (`runInLockedClearance`). Гипотеза записи — цикл по строкам: «строка версии → строки глав»
 * против «строка главы → строка версии» (`40P01`).
 *
 * Проба держит **настоящую** транзакцию одной стороны на полпути и пускает навстречу вторую:
 * писатель держится в `checkVersionStaleness` (замок группы, строка версии и своя строка уже
 * взяты), удаление — в первом `adminAudit.record` (строка версии и каскад уже сняты). Что вторая
 * сторона встала в очередь, а не проскочила, проверяется `pg_blocking_pids` против соединения
 * держателя (кто-то в базе воркера ждёт именно его) — без этого зелёная проба ничего не значит.
 *
 * Охват — все 12 писателей под `runInLockedClearance` против прямого удаления той же версии
 * и против удаления книги, плюс писатель **соседней** версии той же группы против удаления книги.
 * Чего проба не видит (условия переоткрытия `LEGACY-431`): писателей вне обёртки и пересчёт
 * набора версий через `runInLockedClearanceScope`.
 *
 * Контроль: тот же стенд ловит настоящий цикл — две транзакции, берущие строки двух версий
 * в обратном порядке, получают `40P01`.
 */
describe('LEGACY-431 — удаление версии и книги против писателей под замком группы (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let chapters: ChapterService;
  let audio: AudioChapterService;
  let versions: BookVersionService;
  let books: BookService;
  let audit: AdminAuditService;
  let hash: RightsContentHashService;

  const stamp = Date.now();
  const slugs: string[] = [];
  const personIds: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    chapters = moduleRef.get(ChapterService);
    audio = moduleRef.get(AudioChapterService);
    versions = moduleRef.get(BookVersionService);
    books = moduleRef.get(BookService);
    audit = moduleRef.get(AdminAuditService);
    hash = moduleRef.get(RightsContentHashService);
    await moduleRef.init();
  });

  afterAll(async () => {
    try {
      for (const slug of slugs) {
        await cleanupBookWithRights(prisma as unknown as PrismaClient, slug);
      }
      await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    } finally {
      await moduleRef?.close();
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Книга с двумя версиями одной группы прав. У целевой есть всё, что сносит каскад и трогают
   * писатели: глава, аудиоглава, участник; у соседней — глава.
   */
  const makeBook = async () => {
    const slug = `t78-${stamp}-${slugs.length}`;
    slugs.push(slug);
    const fx = await createBookWithRights(prisma as unknown as PrismaClient, slug);
    const makeVersion = (language: Language) =>
      prisma.bookVersion.create({
        data: {
          bookId: fx.book.id,
          language,
          slug: `${slug}-${language}`,
          title: `${slug}-${language}`,
          author: 'A',
          description: 'D',
          coverImageUrl: 'https://example.com/c.jpg',
          type: BookType.text,
          isFree: true,
          status: 'draft',
          rightsProfileId: fx.profile.id,
          approvedRightsReviewId: fx.review.id,
        },
      });
    const target = await makeVersion(Language.en);
    const neighbour = await makeVersion(Language.es);
    const chapter = await prisma.chapter.create({
      data: { bookVersionId: target.id, number: 1, title: 'c1', content: 'text' },
    });
    const neighbourChapter = await prisma.chapter.create({
      data: { bookVersionId: neighbour.id, number: 1, title: 'n1', content: 'text' },
    });
    const audioChapter = await prisma.audioChapter.create({
      data: {
        bookVersionId: target.id,
        number: 1,
        title: 'a1',
        audioUrl: 'https://example.com/a1.mp3',
        duration: 60,
      },
    });
    const person = await prisma.person.create({ data: { canonicalName: `${slug}-person` } });
    personIds.push(person.id);
    const contributor = await prisma.bookVersionContributor.create({
      data: { bookVersionId: target.id, personId: person.id, role: ContributorRole.TRANSLATOR },
    });
    // Второй участник: перестановка двух строк — наименьший случай, где порядок строк что-то значит.
    const person2 = await prisma.person.create({ data: { canonicalName: `${slug}-person2` } });
    personIds.push(person2.id);
    const contributor2 = await prisma.bookVersionContributor.create({
      data: { bookVersionId: target.id, personId: person2.id, role: ContributorRole.ILLUSTRATOR },
    });
    return {
      bookId: fx.book.id,
      targetId: target.id,
      neighbourId: neighbour.id,
      chapterId: chapter.id,
      neighbourChapterId: neighbourChapter.id,
      audioChapterId: audioChapter.id,
      personId: person.id,
      contributorId: contributor.id,
      contributor2Id: contributor2.id,
    };
  };

  type Fixture = Awaited<ReturnType<typeof makeBook>>;
  type Deleter = 'удаление версии' | 'удаление книги';
  type Writer = {
    name: string;
    run: (f: Fixture) => Promise<unknown>;
    against: Deleter[];
    /** Где держится писатель, когда он идёт первым; по умолчанию — в `checkVersionStaleness`. */
    hold?: (pause: Pause) => void;
  };

  const deleters: Record<Deleter, (f: Fixture) => Promise<unknown>> = {
    'удаление версии': (f) => versions.remove(f.targetId, null),
    'удаление книги': (f) => books.remove(f.bookId, null),
  };

  const BOTH: Deleter[] = ['удаление версии', 'удаление книги'];

  /** Писатели под `runInLockedClearance` и удаления, с которыми у них общие строки. */
  const writers: Writer[] = [
    {
      name: 'создание главы',
      run: (f) => chapters.create(f.targetId, { title: 'c2', content: 'text' }),
      against: BOTH,
    },
    {
      name: 'правка главы',
      run: (f) => chapters.update(f.chapterId, { title: 'edited' }),
      against: BOTH,
    },
    { name: 'удаление главы', run: (f) => chapters.remove(f.chapterId, null), against: BOTH },
    {
      name: 'создание аудиоглавы',
      run: (f) =>
        audio.create(f.targetId, {
          number: 2,
          title: 'a2',
          audioUrl: 'https://example.com/a2.mp3',
          duration: 60,
        }),
      against: BOTH,
    },
    {
      name: 'правка аудиоглавы',
      run: (f) => audio.update(f.audioChapterId, { title: 'edited' }),
      against: BOTH,
    },
    {
      name: 'удаление аудиоглавы',
      run: (f) => audio.remove(f.audioChapterId, null),
      against: BOTH,
    },
    {
      name: 'порядок аудиоглав',
      run: (f) => audio.reorder(f.targetId, [f.audioChapterId]),
      against: BOTH,
    },
    {
      name: 'правка версии',
      run: (f) => versions.update(f.targetId, { author: 'B' }),
      against: BOTH,
    },
    {
      // Та же ручка, ветка смены слага: пишет `SlugRedirect`, которые удаление версии убирает.
      name: 'смена слага версии',
      run: (f) => versions.update(f.targetId, { slug: `t78-moved-${f.targetId.slice(0, 8)}` }),
      against: BOTH,
    },
    {
      name: 'добавление участника',
      run: (f) =>
        versions.addVersionContributor(f.targetId, {
          personId: f.personId,
          role: DtoContributorRole.EDITOR,
        }),
      against: BOTH,
    },
    {
      name: 'правка участника',
      run: (f) =>
        versions.updateVersionContributor(f.targetId, f.contributorId, { creditedName: 'X' }),
      against: BOTH,
    },
    {
      name: 'удаление участника',
      run: (f) => versions.removeVersionContributor(f.targetId, f.contributorId),
      against: BOTH,
    },
    {
      // `LEGACY-433`: перестановка идёт под замком группы, строки участников — после строки версии.
      // Пометку stale не пишет, поэтому держится в конце тела, до коммита.
      name: 'перестановка участников',
      run: (f) =>
        versions.reorderVersionContributors(f.targetId, {
          contributorIds: [f.contributor2Id, f.contributorId],
        }),
      against: BOTH,
      hold: (pause) => holdLockedBody(pause),
    },
    {
      name: 'правка главы соседней версии',
      run: (f) => chapters.update(f.neighbourChapterId, { title: 'edited' }),
      against: ['удаление книги'],
    },
  ];

  const cases = writers.flatMap((w) => w.against.map((d) => [d, w.name, w] as const));

  const errorText = (result: PromiseSettledResult<unknown>): string => {
    if (result.status === 'fulfilled') return '';
    const reason = result.reason as { code?: string; message?: string };
    return `${reason.code ?? ''} ${reason.message ?? String(result.reason)}`;
  };

  /** Цикл в чистом виде: `40P01` напрямую или в обёртке Prisma (`P2034`). */
  const isDeadlock = (result: PromiseSettledResult<unknown>): boolean =>
    /40P01|deadlock|P2034/i.test(errorText(result));

  /** Цикл или таймаут транзакции (`P2028`) — любой отказ по замку. */
  const isLockFailure = (result: PromiseSettledResult<unknown>): boolean =>
    /40P01|deadlock|P2034|P2028/i.test(errorText(result));

  type Pause = (tx: Prisma.TransactionClient) => Promise<void>;

  /**
   * Держит первую сторону в точке, которую ставит `install`, и пускает навстречу вторую.
   * `release` — в `finally`: если первая сторона закончилась, не дойдя до точки, тест падает
   * сразу с понятной ошибкой, а не висит до таймаута.
   */
  const race = async (
    install: (pause: Pause) => void,
    first: () => Promise<unknown>,
    second: () => Promise<unknown>,
  ) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: (pid: number) => void = () => undefined;
    const inside = new Promise<number>((resolve) => {
      entered = resolve;
    });
    install(async (tx) => {
      entered(await backendPid(tx));
      await held;
    });

    const firstOp = first();
    let secondOp: Promise<unknown> = Promise.resolve();
    let blocked = false;
    try {
      const holderPid = await Promise.race([
        inside,
        firstOp.then(() => {
          throw new Error('первая сторона закончилась, не дойдя до точки удержания');
        }),
      ]);
      secondOp = second();
      blocked = await waitBlockedBy(prisma, holderPid);
    } catch (error) {
      // Обе транзакции дожидаются и здесь: брошенные живыми, они держат строки под чисткой `afterAll`.
      release();
      await Promise.allSettled([firstOp, secondOp]);
      throw error;
    } finally {
      release();
    }
    const [a, b] = await Promise.allSettled([firstOp, secondOp]);
    return { blocked, first: a, second: b };
  };

  /** Писатель держится в `checkVersionStaleness`: `tx` у неё последним аргументом. */
  const holdWriter = (pause: Pause) => {
    const real = hash.checkVersionStaleness.bind(
      hash,
    ) as RightsContentHashService['checkVersionStaleness'];
    jest
      .spyOn(hash, 'checkVersionStaleness')
      .mockImplementationOnce(async (...args: Parameters<typeof real>) => {
        await pause(args[4] as Prisma.TransactionClient);
        return real(...args);
      });
  };

  /** Писатель держится в конце тела под замком группы: `fn` отработал, транзакция ещё не закоммичена. */
  const holdLockedBody = (pause: Pause) => {
    const lock = moduleRef.get(RightsClearanceLockService);
    const real = lock.runInLockedClearance.bind(
      lock,
    ) as RightsClearanceLockService['runInLockedClearance'];
    jest.spyOn(lock, 'runInLockedClearance').mockImplementationOnce(((
      versionId: string,
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) =>
      real(versionId, async (tx) => {
        const result = await fn(tx);
        await pause(tx);
        return result;
      })) as never);
  };

  /** Удаление держится в первом `adminAudit.record`: `tx` у него первым аргументом. */
  const holdDeleter = (pause: Pause) => {
    const real = audit.record.bind(audit) as AdminAuditService['record'];
    jest.spyOn(audit, 'record').mockImplementationOnce(async (...args: Parameters<typeof real>) => {
      await pause(args[0]);
      return real(...args);
    });
  };

  describe.each(cases)('%s против «%s»', (deleterName, _writerName, writer) => {
    it('писатель держит замок группы — удаление встаёт за ним, обе стороны проходят', async () => {
      const f = await makeBook();
      const { blocked, first, second } = await race(
        writer.hold ?? holdWriter,
        () => writer.run(f),
        () => deleters[deleterName](f),
      );

      expect(blocked).toBe(true);
      expect(errorText(first)).toBe('');
      expect(errorText(second)).toBe('');
    });

    it('удаление держит строки — писатель встаёт за ним и получает отказ не по замку', async () => {
      const f = await makeBook();
      const { blocked, first, second } = await race(
        holdDeleter,
        () => deleters[deleterName](f),
        () => writer.run(f),
      );

      expect(blocked).toBe(true);
      expect(errorText(first)).toBe('');
      // Версии к моменту, когда писатель получил строку, уже нет: отказ ожидаем, но не замковый,
      // а «версии нет»: 404 у всех 12 писателей (`LEGACY-434`), не `P2025`/`P2003` (500).
      expect(second.status).toBe('rejected');
      expect(isLockFailure(second)).toBe(false);
      expect((second as PromiseRejectedResult).reason).toBeInstanceOf(NotFoundException);
    });
  });

  it('контроль: стенд ловит настоящий цикл строк двух версий (40P01)', async () => {
    const f = await makeBook();
    const lock = (tx: Prisma.TransactionClient, id: string) =>
      tx.$queryRaw`SELECT id FROM "BookVersion" WHERE id = ${id} FOR UPDATE`;
    let firstHolds: () => void = () => undefined;
    let secondHolds: () => void = () => undefined;
    const first = new Promise<void>((resolve) => (firstHolds = resolve));
    const second = new Promise<void>((resolve) => (secondHolds = resolve));
    const options = { timeout: 20_000, maxWait: 10_000 };
    const t1 = prisma.$transaction(async (tx) => {
      await lock(tx, f.targetId);
      firstHolds();
      await second;
      await lock(tx, f.neighbourId);
    }, options);
    const t2 = prisma.$transaction(async (tx) => {
      await lock(tx, f.neighbourId);
      secondHolds();
      await first;
      await lock(tx, f.targetId);
    }, options);
    const results = await Promise.allSettled([t1, t2]);
    expect(results.filter(isDeadlock)).toHaveLength(1);
  });
});

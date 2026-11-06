import { readFileSync } from 'fs';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { LlmOperationKind } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { cleanupBookWithRights, createBookWithRights } from './helpers/book-with-rights';

const MIGRATION = join(
  __dirname,
  '../prisma/migrations/20261106140000_f07_backfill_content_kind/migration.sql',
);

/** Операторы миграции по одному: Prisma не исполняет несколько команд одним вызовом. */
const statements = (): string[] =>
  readFileSync(MIGRATION, 'utf8')
    .replace(/^\s*--.*$/gm, '')
    .split(/;\s*$/m)
    .map((sql) => sql.trim())
    .filter(Boolean);

/**
 * `F07-3c` (решение арбитра `F07 | F07-3b`, окно выката). Повторная миграция дозаполняет вид
 * операций автозапуска пересказа, которые прежний образ завёл без него.
 */
describe('F07-3c — дозаполнение contentKind операций автозапуска (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  const slug = `f073c-${Date.now()}`;
  let runId = '';
  const operationIds: string[] = [];

  const run = async () => {
    for (const sql of statements()) await prisma.$executeRawUnsafe(sql);
  };
  const kindOf = async (id: string) =>
    (await prisma.llmOperation.findUniqueOrThrow({ where: { id } })).contentKind;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    await moduleRef.init();
  });

  afterAll(async () => {
    if (prisma) {
      if (runId) await prisma.translationRun.deleteMany({ where: { id: runId } });
      await prisma.llmOperation.deleteMany({ where: { id: { in: operationIds } } });
      await cleanupBookWithRights(prisma, slug);
    }
    await moduleRef?.close();
  });

  it('ставит summary_write только операциям draft запуска без вида; прочие и заполненные не трогает; повтор ничего не меняет', async () => {
    const { book } = await createBookWithRights(prisma, slug);
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'Book',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
        status: 'draft',
        originalLanguage: 'English',
      },
    });
    const runOp = await prisma.llmOperation.create({
      data: { kind: 'translation_run', limitUsd: 1 },
    });
    operationIds.push(runOp.id);
    const translationRun = await prisma.translationRun.create({
      data: { operationId: runOp.id, bookVersionId: version.id, sourceLanguage: 'en' },
    });
    runId = translationRun.id;
    const make = async (data: {
      kind: LlmOperationKind;
      translationRunId?: string;
      contentKind?: 'summary_write' | 'analysis_write';
    }) => {
      const op = await prisma.llmOperation.create({ data: { limitUsd: 0, ...data } });
      operationIds.push(op.id);
      return op.id;
    };
    const orphan = await make({ kind: 'draft', translationRunId: runId });
    const analysis = await make({
      kind: 'draft',
      translationRunId: runId,
      contentKind: 'analysis_write',
    });
    const summary = await make({
      kind: 'draft',
      translationRunId: runId,
      contentKind: 'summary_write',
    });
    const manual = await make({ kind: 'draft' });
    // Операции запуска всех прочих видов (`translation_retry`, `dossier` и т.д.) без вида.
    const others: string[] = [];
    for (const kind of Object.values(LlmOperationKind).filter((k) => k !== 'draft')) {
      others.push(await make({ kind, translationRunId: runId }));
    }
    expect(others.length).toBeGreaterThan(0);

    const expectState = async () => {
      expect(await kindOf(orphan)).toBe('summary_write');
      expect(await kindOf(analysis)).toBe('analysis_write');
      expect(await kindOf(summary)).toBe('summary_write');
      expect(await kindOf(manual)).toBeNull();
      for (const id of others) expect(await kindOf(id)).toBeNull();
    };

    expect(statements()).toHaveLength(1);
    await run();
    await expectState();
    await run();
    await expectState();
  });
});

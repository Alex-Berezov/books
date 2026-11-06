import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { startConflict } from './start-conflict';

/**
 * Отказ записи старта хода пересказа и анализа (`F06/tech.md` §4 п.3, `F07-3b`): индекс автозапуска
 * (язык, вид) у автозапуска - тихий `AUTOSTART_DUPLICATE`, остальное - `DRAFT_IN_PROGRESS`.
 */
describe('startConflict', () => {
  const p2002 = (index: string | null) =>
    new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'test',
      meta: {
        modelName: 'ContentDraft',
        driverAdapterError: {
          cause: { kind: 'UniqueConstraintViolation', constraint: index ? { index } : {} },
        },
      },
    });
  const codeOf = (error: unknown) =>
    ((error as ConflictException).getResponse() as { code: string }).code;
  const AUTOSTART_INDEX = 'ContentDraft_translationRunLanguageId_kind_key';

  it('индекс автозапуска у автозапуска - AUTOSTART_DUPLICATE', () => {
    expect(codeOf(startConflict(p2002(AUTOSTART_INDEX), true, 'summary_write'))).toBe(
      'AUTOSTART_DUPLICATE',
    );
  });

  it('индекс автозапуска у ручного старта, строящийся ход и пустой разбор - DRAFT_IN_PROGRESS', () => {
    expect(codeOf(startConflict(p2002(AUTOSTART_INDEX), false, 'summary_write'))).toBe(
      'DRAFT_IN_PROGRESS',
    );
    expect(codeOf(startConflict(p2002('ContentDraft_building_key'), true, 'summary_write'))).toBe(
      'DRAFT_IN_PROGRESS',
    );
    expect(codeOf(startConflict(p2002(null), true, 'summary_write'))).toBe('DRAFT_IN_PROGRESS');
  });

  it('вид хода - в тексте отказа строящегося хода; автозапуск анализа - тот же AUTOSTART_DUPLICATE (F07-3b)', () => {
    const building = startConflict(p2002('ContentDraft_building_key'), false, 'analysis_write');
    expect(codeOf(building)).toBe('DRAFT_IN_PROGRESS');
    expect((building as ConflictException).message).toBe('An analysis run is already being built');
    expect((startConflict(p2002(null), false, 'summary_write') as ConflictException).message).toBe(
      'A summary run is already being built',
    );
    expect(codeOf(startConflict(p2002(AUTOSTART_INDEX), true, 'analysis_write'))).toBe(
      'AUTOSTART_DUPLICATE',
    );
  });

  it('не P2002 - как есть', () => {
    const other = new Error('x');
    expect(startConflict(other, true, 'summary_write')).toBe(other);
  });
});

import { Prisma } from '@prisma/client';
import { waiterMinLimit } from './dossier-builder.service';

const D = (v: string) => new Prisma.Decimal(v);
const op = (limitUsd: string, spentUsd = '0', reservedUsd = '0') => ({
  limitUsd: D(limitUsd),
  spentUsd: D(spentUsd),
  reservedUsd: D(reservedUsd),
});

/** Минимальный лимит ждущего досье или глоссария (`F05-7`, /fix В2): что показать в паузе. */
describe('waiterMinLimit', () => {
  it('помещается - null; не помещается - потрачено + резерв + лимит операции', () => {
    expect(waiterMinLimit(op('10', '1', '2'), D('3'))).toBeNull();
    expect(waiterMinLimit(op('5', '1', '2'), D('3'))?.toFixed(8)).toBe('6.00000000');
  });

  it('больше восьми знаков - вверх: «продолжить» с показанной суммой проходит', () => {
    const min = waiterMinLimit(op('0'), D('0.000001845'));
    expect(min?.toFixed(8)).toBe('0.00000185');
    expect(waiterMinLimit(op((min as Prisma.Decimal).toFixed(8)), D('0.000001845'))).toBeNull();
  });
});

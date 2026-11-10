import { pauseOnFailure } from './pause-by-failure';

describe('pauseOnFailure', () => {
  it.each([
    ['LLM_BUDGET_EXCEEDED:operation', 'LIMIT_REACHED'],
    ['LLM_BUDGET_EXCEEDED:ceiling', 'CEILING_REACHED'],
    ['LLM_INSUFFICIENT_FUNDS', 'INSUFFICIENT_FUNDS'],
    ['LLM_NO_COMPLIANT_PROVIDER', 'NO_COMPLIANT_PROVIDER'],
    ['SOMETHING_ELSE', 'STEP_FAILED'],
  ])('%s pauses the operation with %s, once', async (reason, pause) => {
    const pauseOperation = jest.fn();
    await pauseOnFailure({ pauseOperation } as never, { operationId: 'op1' }, reason);
    expect(pauseOperation).toHaveBeenCalledTimes(1);
    expect(pauseOperation).toHaveBeenCalledWith('op1', pause);
  });
});

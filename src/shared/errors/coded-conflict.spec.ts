import { ConflictException } from '@nestjs/common';
import { llmTaskConflict } from '../../modules/llm-worker/llm-worker.errors';
import { codedConflict } from './coded-conflict';

/** Форма 409 с кодом — одна на сверку вкладки, отказы мира книги (F08-1) и ход модели. */
describe('codedConflict', () => {
  it('409 с кодом; свои поля не затирают statusCode, error, message и code', () => {
    const e = codedConflict('WORLD_ENTITY_REFERENCED', 'refs', {
      referencedBy: ['a'],
      code: 'X',
      statusCode: 500,
    });
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toEqual({
      referencedBy: ['a'],
      statusCode: 409,
      error: 'Conflict',
      message: 'refs',
      code: 'WORLD_ENTITY_REFERENCED',
    });
  });

  it('llmTaskConflict — тот же помощник, а не копия', () => {
    expect(llmTaskConflict).toBe(codedConflict);
  });
});

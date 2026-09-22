import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ApplyClaimBlockDto } from './apply-claim-block.dto';

describe('ApplyClaimBlockDto', () => {
  const base = { reasonRu: 'претензия' };

  const scopeErrors = async (scope: unknown) => {
    const dto = plainToInstance(ApplyClaimBlockDto, { ...base, scope });
    const errors = await validate(dto);
    return errors.filter((error) => error.property === 'scope');
  };

  // LEGACY-027: `SPECIFIC_ASSET` never matches any request (`RightsClaimAccessBlock` carries
  // no asset reference), so the owner forbade the scope at creation rather than widen it.
  it('rejects SPECIFIC_ASSET', async () => {
    expect(await scopeErrors('SPECIFIC_ASSET')).not.toHaveLength(0);
  });

  it.each(['ENTIRE_BOOK', 'LANGUAGE_EDITION', 'TEXT_READER', 'DOWNLOADS', 'AUDIO'])(
    'accepts %s',
    async (scope) => {
      expect(await scopeErrors(scope)).toHaveLength(0);
    },
  );
});

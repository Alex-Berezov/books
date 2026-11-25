import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { codedBadRequest, codedPayloadTooLarge } from './coded-error';

/** 400 и 413 с кодом - та же форма тела, что у 409 `codedConflict` (F08-11d-3). */
describe('coded errors', () => {
  it('codedBadRequest: 400 с кодом', () => {
    const e = codedBadRequest('WORLD_IMAGE_TOO_SMALL', 'small');
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.getResponse()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'small',
      code: 'WORLD_IMAGE_TOO_SMALL',
    });
  });

  it('codedPayloadTooLarge: 413 с кодом', () => {
    const e = codedPayloadTooLarge('WORLD_IMAGE_TOO_LARGE', 'big');
    expect(e).toBeInstanceOf(PayloadTooLargeException);
    expect(e.getStatus()).toBe(413);
    expect(e.getResponse()).toEqual({
      statusCode: 413,
      error: 'Payload Too Large',
      message: 'big',
      code: 'WORLD_IMAGE_TOO_LARGE',
    });
  });
});

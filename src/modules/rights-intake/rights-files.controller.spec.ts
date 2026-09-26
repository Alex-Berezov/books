import type { Response } from 'express';
import { send } from './rights-files.controller';
import type { RightsFileDownload } from './rights-files.service';
import { PRIVATE_NO_STORE } from '../../common/interceptors/cache-control';
import { createResponseStub } from '../../common/testing/response-stub';

/**
 * `LEGACY-108` (остаток `T37`). Три выгрузки контроллера заканчивают ответ
 * сами через `res.end()` — `PrivateVaryInterceptor` до них не доходит вовсе
 * (`headersSent === true` к моменту его фазы «после»), поэтому второй рубеж
 * (`Vary: Authorization`) обязан ставиться прямо здесь.
 *
 * Проверяются итоговые заголовки на носителе с настоящим `vary`, а не факт
 * вызова: поздняя перезапись `Cache-Control` публичным значением красит тест.
 */
describe('rights-files.controller send()', () => {
  const download: RightsFileDownload = {
    buffer: Buffer.from('pdf-bytes'),
    fileName: 'report.pdf',
    contentType: 'application/pdf',
  };

  function makeResponse() {
    const stub = Object.assign(createResponseStub({ Vary: 'Origin' }), { end: jest.fn() });
    return { stub, res: stub as unknown as Response };
  }

  it('итоговый Cache-Control — private, no-store', () => {
    const { stub, res } = makeResponse();

    send(res, download);

    expect(stub.headers['Cache-Control']).toBe(PRIVATE_NO_STORE);
  });

  it('второй рубеж Vary: Authorization ставится до окончания ответа и не затирает Origin', () => {
    const { stub, res } = makeResponse();

    send(res, download);

    expect(stub.headers['Vary']).toBe('Origin, Authorization');
    expect(stub.vary).toHaveBeenCalledTimes(1);
    const varyOrder = stub.vary.mock.invocationCallOrder[0];
    const endOrder = stub.end.mock.invocationCallOrder[0];
    expect(varyOrder).toBeLessThan(endOrder);
  });

  it('отдаёт тело файла одним вызовом', () => {
    const { stub, res } = makeResponse();

    send(res, download);

    expect(stub.end).toHaveBeenCalledTimes(1);
    expect(stub.end).toHaveBeenCalledWith(download.buffer);
  });
});

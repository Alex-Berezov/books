import { docsCacheHeadersMiddleware } from './docs-cache-headers.middleware';
import { PRIVATE_NO_STORE } from '../interceptors/cache-control';

describe('docsCacheHeadersMiddleware', () => {
  function run(path: string) {
    const res = { setHeader: jest.fn() } as unknown as { setHeader: jest.Mock };
    const next = jest.fn();
    docsCacheHeadersMiddleware({ path } as never, res as never, next);
    return { res, next };
  }

  // `/Docs-Json` — Express маршрутизирует без учёта регистра и отдаёт ту же схему.
  it.each(['/docs', '/docs-json', '/docs-yaml', '/docs/', '/Docs-Json', '/DOCS'])(
    'ставит Cache-Control на %s',
    (path) => {
      const { res, next } = run(path);

      expect(res.setHeader).toHaveBeenCalledTimes(1);
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', PRIVATE_NO_STORE);
      expect(next).toHaveBeenCalledTimes(1);
    },
  );

  it('не трогает несвязанные маршруты', () => {
    const { res, next } = run('/api/books');

    expect(res.setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 Похожий, но чужой путь не должен пройти по префиксному совпадению —
   * иначе завтрашний `/docs-legacy-export` молча получил бы наши заголовки.
   */
  it('не путает с похожим по префиксу чужим маршрутом', () => {
    const { res } = run('/docs-legacy-export');

    expect(res.setHeader).not.toHaveBeenCalled();
  });
});

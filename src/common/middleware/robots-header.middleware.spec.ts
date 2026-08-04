import type { NextFunction, Request, Response } from 'express';
import { robotsHeaderMiddleware } from './robots-header.middleware';

function run(path: string) {
  const setHeader = jest.fn();
  const next = jest.fn();
  robotsHeaderMiddleware(
    { path, url: path } as unknown as Request,
    { setHeader } as unknown as Response,
    next as unknown as NextFunction,
  );
  return { setHeader, next };
}

describe('robotsHeaderMiddleware', () => {
  it.each(['/api/en/seo/resolve', '/api/en/books/cards', '/', '/docs', '/en/tag/fear'])(
    'sets X-Robots-Tag: noindex on %s',
    (path) => {
      const { setHeader, next } = run(path);
      expect(setHeader).toHaveBeenCalledWith('X-Robots-Tag', 'noindex');
      expect(next).toHaveBeenCalled();
    },
  );

  it('does not noindex locally served media (would drop covers from Google Images)', () => {
    const { setHeader, next } = run('/static/covers/2026/07/cover.png');
    expect(setHeader).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});

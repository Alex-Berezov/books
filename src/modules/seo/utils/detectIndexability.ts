export function detectIndexability(
  status?: string,
  path?: string,
  robotsOverride?: string | null,
): string {
  if (robotsOverride) {
    return robotsOverride;
  }

  if (status && status !== 'published') {
    return 'noindex, follow';
  }

  if (path) {
    const cleanPath = path.toLowerCase().split('?')[0]; // Strip query params for checking path

    const noIndexSubstrings = [
      '/sign-in',
      '/sign-up',
      '/account',
      '/my-bookshelf',
      '/checkout',
      '/search',
      '/api/',
      '/admin/',
      '/debug/',
    ];

    if (noIndexSubstrings.some((substring) => cleanPath.includes(substring))) {
      return 'noindex, follow';
    }
  }

  return 'index, follow';
}

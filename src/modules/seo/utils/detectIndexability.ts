export function detectIndexability(
  status?: string,
  path?: string,
  robotsOverride?: string | null,
  indexable?: boolean,
): string {
  if (indexable === false) {
    if (robotsOverride) {
      const parts = robotsOverride
        .toLowerCase()
        .split(',')
        .map((s) => s.trim());
      const hasNofollow = parts.some((p) => p === 'nofollow');
      const hasNone = parts.some((p) => p === 'none');
      if (hasNone) return 'none';
      if (hasNofollow) return 'noindex, nofollow';
      return 'noindex, follow';
    }
    return 'noindex, follow';
  }

  if (robotsOverride) {
    return robotsOverride;
  }

  if (status && status !== 'published') {
    return 'noindex, follow';
  }

  if (path) {
    const cleanPath = path.toLowerCase().split('?')[0];

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

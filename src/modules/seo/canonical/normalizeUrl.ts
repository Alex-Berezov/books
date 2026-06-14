export function normalizeUrl(url: string): string {
  if (!url) return '';

  let parsedUrl: URL;
  let isAbsolute = true;

  try {
    parsedUrl = new URL(url);
  } catch {
    isAbsolute = false;
    parsedUrl = new URL(url, 'https://example.com');
  }

  // Lowercase pathname
  let pathname = parsedUrl.pathname.toLowerCase();

  // Strip trailing slash if it is not just "/"
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.substring(0, pathname.length - 1);
  }

  parsedUrl.pathname = pathname;

  if (isAbsolute) {
    // Keep exact string representation
    return parsedUrl.toString();
  } else {
    return parsedUrl.pathname + parsedUrl.search;
  }
}

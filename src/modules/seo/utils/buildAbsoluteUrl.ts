export function buildAbsoluteUrl(path: string): string {
  const base = (process.env.LOCAL_PUBLIC_BASE_URL || 'https://bibliaris.com').replace(/\/$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${base}${cleanPath}`;
}

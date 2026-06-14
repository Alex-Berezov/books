export function truncateMeta(text: string, maxLength: number): string {
  if (!text) return '';
  if (text.length <= maxLength) return text;

  // Try to truncate at a word boundary
  const sub = text.substring(0, maxLength - 3);
  const lastSpace = sub.lastIndexOf(' ');
  if (lastSpace > maxLength / 2) {
    return sub.substring(0, lastSpace) + '...';
  }
  return sub + '...';
}

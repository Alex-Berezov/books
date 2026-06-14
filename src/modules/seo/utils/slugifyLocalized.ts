const cyrillicToLatin: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'yo',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

export function slugifyLocalized(text: string): string {
  let s = text.toLowerCase().trim();
  // Transliterate Cyrillic to Latin
  s = s
    .split('')
    .map((char) => cyrillicToLatin[char] ?? char)
    .join('');
  // Normalize diacritics
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Replace non-alphanumeric characters with hyphens
  s = s.replace(/[^a-z0-9]+/g, '-');
  // Collapse consecutive hyphens and trim trailing/leading hyphens
  return s.replace(/^-+|-+$/g, '').replace(/-+/g, '-');
}

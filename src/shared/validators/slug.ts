export const SLUG_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
export const SLUG_REGEX = new RegExp(SLUG_PATTERN);
export const SLUG_REGEX_README =
  'Lowercase: Latin letters and digits, separator is a hyphen. No spaces, no double or edge hyphens. Examples: "harry-potter", "book-123"';

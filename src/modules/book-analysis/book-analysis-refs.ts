import type { StoredBookAnalysis } from './book-analysis-data';

/** Ошибка перекрёстной ссылки или ключа: путь поля в форме `characters.0.themeKeys.1`. */
export interface BookAnalysisRefError {
  path: string;
  message: string;
}

/**
 * Перекрёстные ссылки (`tech.md` §3) — на **итоговой записи после слияния**, а не на присланном
 * куске: ссылка на тему из прошлого импорта проходит, а очистка тем при живых `themeKeys`
 * отбивается путём ссылающегося поля. Ключи уникальны в своём списке; связь героя — только
 * с героем `main` или `secondary`, не с самим собой.
 */
export function checkAnalysisRefs(blocks: StoredBookAnalysis): BookAnalysisRefError[] {
  const errors: BookAnalysisRefError[] = [];
  const themes = blocks.themes ?? [];
  const characters = blocks.characters ?? [];

  const themeKeys = uniqueKeys(themes, 'themes', errors);
  const characterKeys = uniqueKeys(characters, 'characters', errors);
  const relationTargets = new Set(
    characters.filter((c) => c.role === 'main' || c.role === 'secondary').map((c) => c.key),
  );

  characters.forEach((c, i) => {
    (c.themeKeys ?? []).forEach((key, j) => {
      if (!themeKeys.has(key)) {
        errors.push({
          path: `characters.${i}.themeKeys.${j}`,
          message: `unknown theme key "${key}"`,
        });
      }
    });
    (c.relations ?? []).forEach((r, j) => {
      const path = `characters.${i}.relations.${j}.to`;
      if (r.to === c.key) {
        errors.push({ path, message: 'a character cannot relate to itself' });
      } else if (!characterKeys.has(r.to)) {
        errors.push({ path, message: `unknown character key "${r.to}"` });
      } else if (!relationTargets.has(r.to)) {
        errors.push({
          path,
          message: `"${r.to}" is a minor character; relations go to main or secondary only`,
        });
      }
    });
  });

  (blocks.keyQuotes ?? []).forEach((q, i) => {
    if (q.speakerKey && !characterKeys.has(q.speakerKey)) {
      errors.push({
        path: `keyQuotes.${i}.speakerKey`,
        message: `unknown character key "${q.speakerKey}"`,
      });
    }
    (q.themeKeys ?? []).forEach((key, j) => {
      if (!themeKeys.has(key)) {
        errors.push({
          path: `keyQuotes.${i}.themeKeys.${j}`,
          message: `unknown theme key "${key}"`,
        });
      }
    });
  });

  return errors;
}

function uniqueKeys(
  items: { key: string }[],
  list: string,
  errors: BookAnalysisRefError[],
): Set<string> {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    if (seen.has(item.key)) {
      errors.push({ path: `${list}.${i}.key`, message: `duplicate key "${item.key}"` });
    }
    seen.add(item.key);
  });
  return seen;
}

/** Номер главы из блоков с путём поля — для предупреждения о главе, которой нет в версии (T4). */
export function collectChapterRefs(
  blocks: StoredBookAnalysis,
): { path: string; chapter: number }[] {
  const refs: { path: string; chapter: number }[] = [];
  const push = (path: string, chapter: number | null | undefined) => {
    if (typeof chapter === 'number') refs.push({ path, chapter });
  };
  (blocks.themes ?? []).forEach((t, i) => {
    (t.chapters ?? []).forEach((n, j) => push(`themes.${i}.chapters.${j}`, n));
    (t.quotes ?? []).forEach((q, j) => push(`themes.${i}.quotes.${j}.chapter`, q.chapter));
  });
  (blocks.characters ?? []).forEach((c, i) =>
    push(`characters.${i}.quote.chapter`, c.quote?.chapter),
  );
  (blocks.symbols ?? []).forEach((s, i) => {
    (s.chapters ?? []).forEach((n, j) => push(`symbols.${i}.chapters.${j}`, n));
    push(`symbols.${i}.quote.chapter`, s.quote?.chapter);
  });
  (blocks.keyQuotes ?? []).forEach((q, i) => push(`keyQuotes.${i}.chapter`, q.chapter));
  (blocks.style ?? []).forEach((s, i) => push(`style.${i}.example.chapter`, s.example?.chapter));
  return refs;
}

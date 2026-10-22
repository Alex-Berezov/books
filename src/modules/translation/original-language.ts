import { Language } from '@prisma/client';

/**
 * Итог сведения поля «язык оригинала» к коду (Р10, `product.md` §2.1). Поле в базе - свободный
 * текст и не переписывается: сводится каждый раз при чтении.
 */
export type OriginalLanguage =
  | { kind: 'site'; code: Language }
  | { kind: 'other'; code: string }
  | { kind: 'unknown' };

const SITE_LOCALES = Object.values(Language);

/**
 * Пять языков сайта: ISO 639-1, ISO 639-2 (B и T) и названия на пяти языках сайта, включая
 * самоназвание и женский род прилагательного («langue française», «língua portuguesa»). Таблица своя, а не из `Intl`: от неё зависит, какая версия станет исходником.
 */
const SITE_LANGUAGE_NAMES: Record<Language, string[]> = {
  en: ['en', 'eng', 'english', 'ingles', 'inglesa', 'anglais', 'anglaise', 'английский'],
  es: [
    'es',
    'spa',
    'spanish',
    'espanol',
    'espanola',
    'castellano',
    'espagnol',
    'espagnole',
    'espanhol',
    'espanhola',
    'испанский',
  ],
  fr: ['fr', 'fra', 'fre', 'french', 'frances', 'francesa', 'francais', 'francaise', 'французский'],
  pt: [
    'pt',
    'por',
    'portuguese',
    'portugues',
    'portuguesa',
    'portugais',
    'portugaise',
    'португальский',
  ],
  ru: ['ru', 'rus', 'russian', 'ruso', 'rusa', 'russe', 'russo', 'russa', 'русский'],
};

/**
 * ISO 639-1 без пяти языков сайта: по нему распознаётся язык вне пяти (код, название
 * из `Intl.DisplayNames` на пяти локалях сайта или самоназвание).
 */
const ISO_639_1 =
  'aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs ca ce ch co cr cs cu cv cy ' +
  'da de dv dz ee el eo et eu fa ff fi fj fo fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia ' +
  'id ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku kv kw ky la lb lg li ln ' +
  'lo lt lu lv mg mh mi mk ml mn mr ms mt my na nb nd ne ng nl nn no nr nv ny oc oj om or os pa ' +
  'pi pl ps qu rm rn ro rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv sw ta te tg th ti ' +
  'tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo wa wo xh yi yo za zh zu';

/** Служебные слова вокруг названия: «английский язык», «langue française», «English language». */
const FILLER_WORDS = new Set(['язык', 'language', 'langue', 'idioma', 'lengua', 'lingua']);

/** Регистр, диакритика, пробелы, скобки и служебные слова не влияют на результат. */
export function normalizeLanguageName(raw: string): string {
  const words = raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER_WORDS.has(w));
  return words.join(' ');
}

/**
 * Исторические языки без кода ISO 639-1 - коды 639-2/3 для классики (решение арбитра
 * `F05 | F05-2`, Р10): исход `other`, перевод с английской. К языку сайта не сводятся:
 * `enm`/`ang` - не `en`, `fro`/`frm` - не `fr`. Живые языки трёхбуквенным кодом сюда не идут.
 */
const HISTORICAL_LANGUAGES = 'grc ang enm fro frm goh gmh non sga got peo akk egy';

let lookup: Map<string, OriginalLanguage> | null = null;

function buildLookup(): Map<string, OriginalLanguage> {
  const map = new Map<string, OriginalLanguage>();
  // Языки вне пяти - первыми: имена пяти языков ниже перекрывают совпадения (их таблица главная).
  const displays = SITE_LOCALES.map((l) => new Intl.DisplayNames([l], { type: 'language' }));
  for (const code of [...ISO_639_1.split(' '), ...HISTORICAL_LANGUAGES.split(' ')]) {
    const other: OriginalLanguage = { kind: 'other', code };
    map.set(code, other);
    // Самоназвание («Deutsch», «italiano») - тем же `Intl` на локали самого языка.
    for (const display of [...displays, new Intl.DisplayNames([code], { type: 'language' })]) {
      const name = display.of(code);
      // `of` без названия возвращает сам код - такое имя ничего не добавляет.
      if (name && name !== code) map.set(normalizeLanguageName(name), other);
    }
  }
  for (const code of SITE_LOCALES) {
    for (const name of SITE_LANGUAGE_NAMES[code]) {
      map.set(normalizeLanguageName(name), { kind: 'site', code });
    }
  }
  return map;
}

/**
 * Сводит поле «язык оригинала» к коду: код (`pt`, `pt-BR`, `por`) или название на любом из пяти
 * языков сайта. Пусто или не распознано - `unknown`.
 */
export function resolveOriginalLanguage(raw: string | null | undefined): OriginalLanguage {
  if (!raw || !raw.trim()) return { kind: 'unknown' };
  lookup ??= buildLookup();
  const normalized = normalizeLanguageName(raw);
  const direct = lookup.get(normalized);
  if (direct) return direct;
  // Тег с регионом или письменностью: `pt-BR`, `pt_br`, `zh-Hant` - по основе.
  const tag = /^([a-z]{2,3})(?:[-_][a-z0-9]{2,8})+$/.exec(raw.trim().toLowerCase());
  if (tag) {
    const base = lookup.get(tag[1]);
    if (base) return base;
  }
  return { kind: 'unknown' };
}

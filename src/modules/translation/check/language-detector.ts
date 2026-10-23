import { Language } from '@prisma/client';
import { getSupportedLanguages } from '../../../shared/language/language.util';

/**
 * Детектор языка текста перевода (`F05-5`, шаг 1; Р3): свой, без пакета - служебные слова пяти
 * языков сайта, диакритика и характерные сочетания. Кириллица у пяти языков одна - `ru`
 * определяется по письму. Замер на корпусе общественного достояния - `language-detector.spec.ts`
 * (пороги Р3: на кусках 1500-3000 слов ноль ошибок `es↔pt` и точность от 99 %, на окне
 * 3-5 предложений от 95 %).
 */

/** Языки сайта - из enum схемы: язык без своих служебных слов не соберётся (`STOPWORDS`). */
export const DETECTED_LANGUAGES: readonly Language[] = getSupportedLanguages();

const STOPWORDS: Record<Exclude<Language, 'ru'>, string> = {
  en:
    'the and of to in is it that was he for with his her you not on as at but be had have they ' +
    'she him this which from were would there their what said been an my me we so all if will ' +
    'one when who them or by into could then do did out up very upon your are any more only now ' +
    'some how than after well before never been should those these its our us about over such',
  es:
    'el la los las del al y en que de un una unos unas es por con no se lo le les como más pero ' +
    'su sus ya muy también fue era había este esta estos estas ese esa eso esto cuando porque ' +
    'sin sobre entre hasta desde donde quien todo todos nos mi me yo él ella usted ustedes hay ' +
    'ser estaba tiene tenía dijo así bien algo nada mucho poco otro otra sí señor entonces ' +
    'después aquí ahora siempre hacia mientras aunque cual qué cómo pues aún ni eran han ha he ' +
    'hecho hombre vez día ellos ellas nosotros para cuyo aquel aquella hubo muchos están son',
  fr:
    'le la les des du de et est une un il elle ils elles je tu nous vous ne pas qui que dans ' +
    'pour sur avec au aux ce cette ces mais ou où son sa ses leur leurs se en lui me te mon ma ' +
    'mes a était avait été être avoir fait dit plus tout tous bien comme si même aussi alors ' +
    'encore sans très peu rien quand puis après avant chez donc car cela ça qu homme jour ' +
    'monsieur madame oui non peut fut sont ont avaient étaient celui cette quelque',
  pt:
    'o a os as do da dos das no na nos nas ao aos à às e em que de um uma uns umas é por com ' +
    'não se como mais mas seu sua seus suas já muito também foi era havia este esta isto isso ' +
    'esse essa aquele aquela quando porque sem sobre entre até desde onde quem tudo todos meu ' +
    'minha eu ele ela eles elas você há ser estava tem tinha disse assim bem algo nada pouco ' +
    'outro outra sim senhor então depois aqui agora sempre para pela pelo pelos pelas num numa ' +
    'dele dela lhe lhes nem ainda coisa homem vez dia nós porém mesmo seja foram são estão ter',
};

type LatinLanguage = keyof typeof STOPWORDS;
const LATIN = Object.keys(STOPWORDS) as LatinLanguage[];

/** Слово → языки, у которых оно служебное; вес слова делится между ними поровну. */
const WORD_LANGUAGES = new Map<string, LatinLanguage[]>();
for (const language of LATIN) {
  for (const word of STOPWORDS[language].split(' ')) {
    const list = WORD_LANGUAGES.get(word) ?? [];
    if (!list.includes(language)) list.push(language);
    WORD_LANGUAGES.set(word, list);
  }
}

/** Служебные слова латинских языков сайта: артикли, предлоги, местоимения. */
export const FUNCTION_WORDS: ReadonlySet<string> = new Set(WORD_LANGUAGES.keys());

/** Признаки письма: вес на каждое вхождение - буквы и сочетания, которых у соседей нет. */
const MARKERS: ReadonlyArray<{ pattern: RegExp; weights: Partial<Record<LatinLanguage, number>> }> =
  [
    { pattern: /ñ/g, weights: { es: 3 } },
    { pattern: /[¿¡]/g, weights: { es: 3 } },
    { pattern: /ción\b|ciones\b/g, weights: { es: 2 } },
    { pattern: /[ãõ]/g, weights: { pt: 3 } },
    { pattern: /ção\b|ções\b/g, weights: { pt: 2 } },
    { pattern: /\p{L}(?:nh|lh)\p{L}/gu, weights: { pt: 1 } },
    { pattern: /[èëïœîû]/g, weights: { fr: 1 } },
    { pattern: /(?<!\p{L})(?:qu|l|d|n|s|j|c|m)['’]\p{L}/gu, weights: { fr: 1 } },
    { pattern: /\p{L}(?:['’]s|n['’]t)(?!\p{L})/gu, weights: { en: 1 } },
  ];

/** Меньше этого веса - признаков нет (имена, числа, обрывки): язык не определён, а не «чужой». */
const DETECTOR_MIN_EVIDENCE = 4;
/** Доля веса победителя над вторым ниже этой - не определён: ничья не даёт «чужого» языка. */
const DETECTOR_MIN_MARGIN = 0.1;

export interface LanguageGuess {
  /** `null` - признаков мало или ничья. */
  language: Language | null;
  scores: Record<Language, number>;
}

/** Слова текста в нижнем регистре: буквы с апострофом внутри французского слова режутся по нему. */
export function wordsOf(text: string): string[] {
  return (
    text
      .toLowerCase()
      .normalize('NFC')
      .match(/\p{L}+/gu) ?? []
  );
}

/**
 * Язык текста. `exclude` - слова, которые не считаются (формы записей глоссария: имена,
 * оставленные в оригинале, решение арбитра `F05 | F05-5`); сравнение в нижнем регистре.
 */
export function detectLanguage(
  text: string,
  exclude: ReadonlySet<string> = new Set(),
): LanguageGuess {
  const scores: Record<Language, number> = { en: 0, es: 0, fr: 0, pt: 0, ru: 0 };
  const words = wordsOf(text).filter((w) => !exclude.has(w));
  let cyrillic = 0;
  let latin = 0;
  for (const word of words) {
    if (/\p{Script=Cyrillic}/u.test(word)) cyrillic++;
    else if (/\p{Script=Latin}/u.test(word)) latin++;
    const languages = WORD_LANGUAGES.get(word);
    if (!languages) continue;
    for (const language of languages) scores[language] += 1 / languages.length;
  }
  if (cyrillic > latin) {
    // У `ru` одно письмо на пять языков: слово кириллицей - признак полного веса.
    scores.ru = cyrillic;
  } else {
    const lower = text.toLowerCase().normalize('NFC');
    for (const { pattern, weights } of MARKERS) {
      const hits = lower.match(pattern)?.length ?? 0;
      if (hits === 0) continue;
      for (const [language, weight] of Object.entries(weights) as Array<[LatinLanguage, number]>) {
        scores[language] += hits * weight;
      }
    }
  }
  const ranked = [...DETECTED_LANGUAGES].sort((a, b) => scores[b] - scores[a]);
  const [top, second] = [scores[ranked[0]], scores[ranked[1]]];
  if (top < DETECTOR_MIN_EVIDENCE || (top - second) / top < DETECTOR_MIN_MARGIN) {
    return { language: null, scores };
  }
  return { language: ranked[0], scores };
}

/** Предложения текста: конец - `.`, `!`, `?`, `…` (с кавычкой или скобкой после) и пробел. */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?…]["»”’)]*)\s+/u)
    .map((s) => s.trim())
    .filter((s) => /\p{L}/u.test(s));
}

/** Окно доли чужого языка: подряд идущие предложения, пока в окне меньше этого числа слов. */
export const FOREIGN_WINDOW_WORDS = 40;

/**
 * Доля слов текста в окнах, уверенно определённых не как `target`. Окно без признаков не чужое:
 * имена и числа языка не дают. Слова `exclude` в счёт не идут ни в окне, ни в знаменателе.
 */
export function foreignShare(
  text: string,
  target: Language,
  exclude: ReadonlySet<string> = new Set(),
): number {
  let total = 0;
  let foreign = 0;
  let window: string[] = [];
  let windowWords = 0;
  const flush = () => {
    if (window.length === 0) return;
    const guess = detectLanguage(window.join(' '), exclude);
    total += windowWords;
    if (guess.language !== null && guess.language !== target) foreign += windowWords;
    window = [];
    windowWords = 0;
  };
  for (const sentence of sentencesOf(text)) {
    window.push(sentence);
    windowWords += wordsOf(sentence).filter((w) => !exclude.has(w)).length;
    if (windowWords >= FOREIGN_WINDOW_WORDS) flush();
  }
  flush();
  return total === 0 ? 0 : foreign / total;
}

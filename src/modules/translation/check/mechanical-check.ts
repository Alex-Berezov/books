import { Language } from '@prisma/client';
import { richHtmlText } from '../../../shared/sanitize/rich-html-text';
import { LANGUAGE_NAMES } from '../dossier/dossier.prompts';
import { TranslatedBlock } from '../translate/translate.format';
import { CHECK_FLAG_REASONS, CheckFlagReason } from './check.constants';
import {
  detectLanguage,
  FOREIGN_WINDOW_WORDS,
  foreignShare,
  FUNCTION_WORDS,
  wordsOf,
} from './language-detector';
import { LENGTH_CHECK_MIN_CHARS, lengthCorridor, textLength } from './length-corridors';

/**
 * Механика куска кодом (`F05-5`, шаг 2; `tech.md` §6, 5а): язык и доля чужого, блок на чужом
 * языке, отношение длины, номера и пустые блоки, служебные фразы, обрыв. Плюс имена (шаг 3):
 * форма глоссария в переводе (`formFound`); не нашлась - пометка для сверки смысла, а не провал.
 */

/** Доля слов в окнах чужого языка, с которой механика проваливается (замер - спек детектора). */
export const FOREIGN_SHARE_MAX = 0.2;

export interface CheckFailure {
  code: CheckFlagReason;
  /** Замечание переводчику на повтор - по-английски, как промпт. */
  remark: string;
}

/** Записи глоссария с формой перевода: по ним - имена и исключения из доли чужого языка. */
export function nameEntriesOf(entries: readonly unknown[]): NameEntry[] {
  return entries.flatMap((e) => {
    const r = (e ?? {}) as Record<string, unknown>;
    if (typeof r.key !== 'string' || typeof r.source !== 'string' || typeof r.target !== 'string') {
      return [];
    }
    return [
      { key: r.key, source: r.source, target: r.target, keepOriginal: r.keepOriginal === true },
    ];
  });
}

/** Запись глоссария, встреченная в исходнике куска: её форма ищется в переводе. */
export interface NameEntry {
  key: string;
  source: string;
  target: string;
  keepOriginal?: boolean;
}

export interface MechanicalInput {
  sourceLanguage: Language;
  targetLanguage: Language;
  /** Переводимые блоки куска исходника. */
  source: ReadonlyArray<{ n: number; html: string }>;
  translated: readonly TranslatedBlock[];
  /** Записи глоссария куска (`glossaryFor`): по ним - исключения из доли чужого и имена. */
  glossary: readonly NameEntry[];
}

export interface MechanicalResult {
  failures: CheckFailure[];
  language: Language | null;
  foreignShare: number;
  lengthRatio: number | null;
  /** Ключи записей глоссария, чья форма в переводе не нашлась (`formFound`) - вопрос сверке смысла. */
  nameMisses: string[];
}

/** Нижний регистр без диакритики: сравнение форм имён и служебных фраз. */
export function normalized(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[’‘]/g, "'");
}

/** Служебные слова пяти языков без диакритики: в форме имени это артикли и предлоги. */
const FUNCTION_WORDS_NORMALIZED = new Set([...FUNCTION_WORDS].map((w) => normalized(w)));

/**
 * Слова формы без артиклей и предлогов («de las», «del», «von»): служебные слова пяти языков
 * не считаются; форма из одних служебных («Will») - целиком. Английское притяжательное «’s»
 * словом не считается («Kurtz’s station» - «kurtz» и «station»): иначе «s» из «s’il» находит
 * форму в любом французском тексте (живой прогон F05-9).
 */
function significantWords(form: string): string[] {
  const words =
    normalized(form)
      .replace(/(\p{L})'s(?!\p{L})/gu, '$1')
      .match(/\p{L}+/gu) ?? [];
  const named = words.filter((w) => !FUNCTION_WORDS_NORMALIZED.has(w));
  return named.length > 0 ? named : words;
}

/**
 * Склоняет имена из пяти языков сайта только русский: в остальных форма имени в тексте - то же
 * слово (притяжательное «Mark's» режется апострофом на «mark» и «s»).
 */
const INFLECTING: ReadonlySet<Language> = new Set(['ru']);
/** Окончание имени, снимаемое перед сравнением: «Мария» - «Мари», «Анна» - «Анн». */
const NAME_ENDING = /[аяоеиыуюь]$/u;
/** Падежное окончание не длиннее этого: «Анн-ой», «Бориса», «Марию». */
const CASE_ENDING_MAX = 3;
/** Короче - только целым словом: «Ян» не находится в «Яна» - промах лишь вопрос сверке. */
const INFLECTED_NAME_MIN = 4;

/** Слово текста - форма слова имени: целиком или (у склоняющего языка) основа с падежом. */
function wordForm(nameWord: string, word: string, inflecting: boolean): boolean {
  if (word === nameWord) return true;
  if (!inflecting || nameWord.length < INFLECTED_NAME_MIN) return false;
  const base = nameWord.replace(NAME_ENDING, '');
  return word.startsWith(base) && word.length - base.length <= CASE_ENDING_MAX;
}

/**
 * Встречается ли форма в тексте: каждое значимое слово формы - словом текста (`wordForm`). Ложная
 * находка дороже промаха: промах - лишь вопрос сверке смысла, находка прячет потерянное имя,
 * поэтому «Sol» не находится в «solo», «Paris» в «para», «Mark» в «market», а многословное имя -
 * по одному нарицательному слову («de las Casas» в «las casas»).
 */
export function formFound(form: string, textWords: readonly string[], language: Language): boolean {
  const inflecting = INFLECTING.has(language);
  return significantWords(form).every((nameWord) =>
    textWords.some((w) => wordForm(nameWord, w, inflecting)),
  );
}

/**
 * Служебные фразы модели на пяти языках, без диакритики, группами по смыслу. Фраза ищется целыми
 * словами («as an ai» - не «as an aide»). Группа, фраза которой есть в исходнике на любом языке
 * (авторское «Примечание переводчика» в переводе - «Translator's note»), провалом не считается.
 */
const SERVICE_PHRASE_GROUPS: ReadonlyArray<readonly string[]> = [
  [
    'here is the translation',
    "here's the translation",
    'translated text',
    'вот перевод',
    'aqui esta la traduccion',
    'voici la traduction',
    'aqui esta a traducao',
  ],
  [
    "translator's note",
    'примечание переводчика',
    'nota del traductor',
    'note du traducteur',
    'nota do tradutor',
  ],
  ['as an ai', 'i hope this translation'],
];

function hasPhrase(normalizedText: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(normalizedText);
}

/** Конец законченного предложения: знак конца, за ним кавычки и скобки. */
const SENTENCE_END = /[.!?…:;»«"“”„'’‘)\]›*—–-]\s*$/u;

const plain = (html: string) => richHtmlText(html).trim();

/**
 * Текст куска без разметки - исходник и перевод по номерам исходных блоков, блок строкой.
 * Одно правило на механику, сверку смысла и её оценку.
 */
export function pieceTexts(
  source: ReadonlyArray<{ n: number; html: string }>,
  translated: readonly TranslatedBlock[] = [],
): { sourceText: string; translatedText: string } {
  const byNumber = new Map(translated.map((b) => [b.n, plain(b.text)]));
  return {
    sourceText: source.map((b) => plain(b.html)).join('\n'),
    translatedText: source.map((b) => byNumber.get(b.n) ?? '').join('\n'),
  };
}

/** Замечание о чужом языке перевода - одно на механику и Jev. */
export function remarkOfLanguage(target: Language, found: Language): string {
  return (
    `The translation is not in ${LANGUAGE_NAMES[target]}: it reads as ${LANGUAGE_NAMES[found]}. ` +
    `Translate every block into ${LANGUAGE_NAMES[target]}.`
  );
}

export function checkMechanical(input: MechanicalInput): MechanicalResult {
  const failures: CheckFailure[] = [];
  const { sourceText, translatedText } = pieceTexts(input.source, input.translated);
  const byNumber = new Map(input.translated.map((b) => [b.n, plain(b.text)]));

  // Формы глоссария не считаются чужим языком (решение арбитра `F05 | F05-5`): имя, оставленное
  // в оригинале, и транслитерация. Слова исходника - не исключение, иначе непереведённый кусок
  // проходил бы проверку.
  // Служебные слова формы («el Viejo de la Montaña») не исключаются: это главные признаки языка.
  const exclude = new Set(
    input.glossary
      .flatMap((e) => [...wordsOf(e.target), ...(e.keepOriginal ? wordsOf(e.source) : [])])
      .filter((w) => !FUNCTION_WORDS.has(w)),
  );
  const language = detectLanguage(translatedText, exclude).language;
  const share = foreignShare(translatedText, input.targetLanguage, exclude);
  // Абзац на чужом языке среди своих проходит долю (решение арбитра `F05 | F05-5`): блок от
  // окна доли, уверенно определённый не целевым языком, - провал сам по себе.
  const foreignBlocks = input.source
    .map((b) => ({ n: b.n, text: byNumber.get(b.n) ?? '' }))
    .filter((b) => wordsOf(b.text).filter((w) => !exclude.has(w)).length >= FOREIGN_WINDOW_WORDS)
    .filter((b) => {
      const found = detectLanguage(b.text, exclude).language;
      return found !== null && found !== input.targetLanguage;
    })
    .map((b) => b.n);
  if (language !== null && language !== input.targetLanguage) {
    failures.push({
      code: CHECK_FLAG_REASONS.LANGUAGE_MISMATCH,
      remark: remarkOfLanguage(input.targetLanguage, language),
    });
  } else if (share >= FOREIGN_SHARE_MAX) {
    failures.push({
      code: CHECK_FLAG_REASONS.FOREIGN_SHARE,
      remark:
        `Part of the translation is not in ${LANGUAGE_NAMES[input.targetLanguage]}. ` +
        'Translate every sentence; keep in the original only what the glossary says to keep.',
    });
  } else if (foreignBlocks.length > 0) {
    failures.push({
      code: CHECK_FLAG_REASONS.FOREIGN_BLOCK,
      remark:
        `Blocks ${foreignBlocks.join(', ')} are not in ${LANGUAGE_NAMES[input.targetLanguage]}. ` +
        'Translate them; keep in the original only what the glossary says to keep.',
    });
  }

  const expected = input.source.map((b) => b.n).sort((a, b) => a - b);
  const got = [...byNumber.keys()].sort((a, b) => a - b);
  if (expected.length !== got.length || expected.some((n, i) => n !== got[i])) {
    failures.push({
      code: CHECK_FLAG_REASONS.BLOCKS_MISMATCH,
      remark: `Return exactly the blocks ${expected.join(', ')}, each with its number.`,
    });
  }
  const empty = input.source
    .filter((b) => plain(b.html) !== '' && (byNumber.get(b.n) ?? '') === '')
    .map((b) => b.n);
  if (empty.length > 0) {
    failures.push({
      code: CHECK_FLAG_REASONS.BLOCK_EMPTY,
      remark: `Blocks ${empty.join(', ')} came back empty. Translate the whole text of every block.`,
    });
  }

  const corridor = lengthCorridor(input.sourceLanguage, input.targetLanguage);
  const sourceLength = textLength(sourceText);
  const ratio = sourceLength > 0 ? textLength(translatedText) / sourceLength : null;
  if (corridor && ratio !== null && sourceLength >= LENGTH_CHECK_MIN_CHARS) {
    if (ratio < corridor[0] || ratio > corridor[1]) {
      failures.push({
        code: CHECK_FLAG_REASONS.LENGTH_OUT_OF_RANGE,
        remark:
          ratio < corridor[0]
            ? 'The translation is much shorter than the source: something is left out. ' +
              'Translate the whole meaning of every block.'
            : 'The translation is much longer than the source. Add nothing that is not in ' +
              'the source: no comments, notes or explanations.',
      });
    }
  }

  const sourceNormalized = normalized(sourceText);
  const translatedNormalized = normalized(translatedText);
  const phrase = SERVICE_PHRASE_GROUPS.filter(
    (group) => !group.some((p) => hasPhrase(sourceNormalized, p)),
  ).some((group) => group.some((p) => hasPhrase(translatedNormalized, p)));
  if (phrase) {
    failures.push({
      code: CHECK_FLAG_REASONS.SERVICE_PHRASE,
      remark: 'Return only the translation of the blocks: no introduction, notes or comments.',
    });
  }

  const sourceLast = input.source
    .map((b) => plain(b.html))
    .filter((t) => t !== '')
    .at(-1);
  const translatedLast = input.source
    .map((b) => byNumber.get(b.n) ?? '')
    .filter((t) => t !== '')
    .at(-1);
  if (
    sourceLast !== undefined &&
    translatedLast !== undefined &&
    SENTENCE_END.test(sourceLast) &&
    !SENTENCE_END.test(translatedLast)
  ) {
    failures.push({
      code: CHECK_FLAG_REASONS.TRUNCATED,
      remark:
        'The translation breaks off before the end of the last block. Translate it to the end.',
    });
  }

  const sourceWords = sourceNormalized.match(/\p{L}+/gu) ?? [];
  const translatedWords = translatedNormalized.match(/\p{L}+/gu) ?? [];
  const nameMisses = input.glossary
    .filter(
      (e) =>
        formFound(e.source, sourceWords, input.sourceLanguage) &&
        !formFound(e.target, translatedWords, input.targetLanguage),
    )
    .map((e) => e.key);

  return { failures, language, foreignShare: share, lengthRatio: ratio, nameMisses };
}

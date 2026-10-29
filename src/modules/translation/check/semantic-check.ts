import { Language } from '@prisma/client';
import { LlmChatMessage } from '../../llm/openrouter.client';
import { Shape } from '../dossier/dossier.format';
import { LANGUAGE_NAMES, shapedRequest } from '../dossier/dossier.prompts';
import { FENCE_RULE, fenced } from '../fenced-data';
import { sentencesOf } from './language-detector';
import { CHECK_FLAG_REASONS } from './check.constants';
import { CheckFailure, NameEntry } from './mechanical-check';
import { SEMANTIC_SAMPLES_MAX, SEMANTIC_SAMPLES_MIN } from './check.constants';

/**
 * Сверка смысла куска моделью (`F05-5`, шаг 4; `tech.md` §6, 5б): 3-5 случайных предложений
 * исходника по сиду куска, полнота куска, разбор имён, не найденных механикой.
 */

const SEMANTIC_VERDICTS = ['pass', 'fail', 'unsure'] as const;
const NAME_VERDICTS = ['inflected', 'pronoun', 'lost'] as const;

/** Неизвестное значение вердикта - ошибка формы и повтор с замечанием (решение арбитра `F05 | F05-5`). */
export const SEMANTIC_SHAPE: Shape = {
  object: {
    verdict: { enum: [...SEMANTIC_VERDICTS] },
    samples: {
      array: { object: { source: 'string', translation: 'string', accurate: 'boolean' } },
    },
    omissions: { array: 'string' },
    nameFlags: { array: { object: { key: 'string', verdict: { enum: [...NAME_VERDICTS] } } } },
    remarks: { array: 'string' },
  },
};

export interface SemanticAnswer {
  verdict: (typeof SEMANTIC_VERDICTS)[number];
  samples: Array<{ source: string; translation: string; accurate: boolean }>;
  omissions: string[];
  nameFlags: Array<{ key: string; verdict: (typeof NAME_VERDICTS)[number] }>;
  remarks: string[];
}

/** Семейство модели - префикс до `/` в её имени (`tech.md` §3). */
export const familyOf = (model: string): string => model.split('/')[0];

/**
 * Модели проверки другого семейства, чем модели, фактически переведшие проверяемый текст (кусок -
 * одна, стык и глава - модели всех своих кусков), в порядке этапа. Пусто - проверить независимо
 * некому (флаг `NOT_INDEPENDENT`). Список - то, что позовёт вызов: переход на запасную по 429 идёт
 * только по нему, и все в нём другого семейства.
 */
export function independentModels(
  candidates: readonly string[],
  translatedBy: string | readonly string[],
): string[] {
  const families = new Set(
    (typeof translatedBy === 'string' ? [translatedBy] : translatedBy).map(familyOf),
  );
  return candidates.filter((m) => !families.has(familyOf(m)));
}

/** Генератор по сиду (mulberry32): тот же сид - те же предложения, повтор шага воспроизводим. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Сид куска из его id: тот же кусок - тот же сид при любом повторе шага. */
export function seedOf(id: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16_777_619);
  return hash >>> 0;
}

/** Предложения исходника на сверку: 3-5 по сиду, в порядке текста. */
export function sampleSentences(text: string, seed: number): string[] {
  const sentences = sentencesOf(text);
  const random = seeded(seed);
  const span = SEMANTIC_SAMPLES_MAX - SEMANTIC_SAMPLES_MIN + 1;
  const count = Math.min(sentences.length, SEMANTIC_SAMPLES_MIN + Math.floor(random() * span));
  const picked = new Set<number>();
  while (picked.size < count) picked.add(Math.floor(random() * sentences.length));
  return [...picked].sort((a, b) => a - b).map((i) => sentences[i]);
}

export interface SemanticInput {
  sourceLanguage: Language;
  targetLanguage: Language;
  sourceText: string;
  translatedText: string;
  samples: string[];
  /** Записи глоссария, чья форма не нашлась механикой. */
  names: readonly NameEntry[];
}

export function semanticMessages(input: SemanticInput): LlmChatMessage[] {
  const from = LANGUAGE_NAMES[input.sourceLanguage];
  const to = LANGUAGE_NAMES[input.targetLanguage];
  return [
    {
      role: 'system',
      content:
        `You check a literary translation from ${from} into ${to}. ` +
        FENCE_RULE +
        ' For every sampled source sentence find the matching ' +
        'passage of the translation (samples: source, translation, accurate). Say what of the ' +
        'source piece is missing from the translation or added to it (omissions; an empty list when ' +
        'nothing is). For every ' +
        'listed name say how the translation renders it: inflected - a grammatical form of the ' +
        'glossary spelling; pronoun - replaced by a pronoun or a description; lost - missing or ' +
        'spelled otherwise. verdict: pass - samples accurate and nothing missing; fail - a ' +
        'sample is wrong or something is missing or added; unsure - you cannot tell. remarks: ' +
        'short notes for the translator to fix a fail.',
    },
    {
      role: 'user',
      content:
        fenced('SOURCE', input.sourceText) +
        '\n\n' +
        fenced('TRANSLATION', input.translatedText) +
        '\n\n' +
        fenced('SAMPLES', input.samples.map((s, i) => `${i + 1}. ${s}`).join('\n')) +
        '\n\n' +
        fenced(
          'NAMES',
          input.names.map((n) => `${n.key}: ${n.source} → ${n.target}`).join('\n') || '(none)',
        ),
    },
  ];
}

export const semanticRequest = (input: SemanticInput) =>
  shapedRequest('check_semantic', SEMANTIC_SHAPE, semanticMessages(input));

/** Ответ после проверки формы: поля, которые не нужны решению, не хранятся. */
export function semanticAnswerOf(value: unknown): SemanticAnswer {
  const v = value as SemanticAnswer;
  return {
    verdict: v.verdict,
    samples: v.samples.map((s) => ({
      source: s.source,
      translation: s.translation,
      accurate: s.accurate,
    })),
    omissions: [...v.omissions],
    nameFlags: v.nameFlags.map((f) => ({ key: f.key, verdict: f.verdict })),
    remarks: [...v.remarks],
  };
}

/** «Ничего не пропущено» словами (`None`, `nothing is missing`, `-`) - не пропуск. */
const NO_OMISSION =
  /^(?:none|nothing|no|n\/a|ningun[oa]?|nada|aucune?|rien|nenhum[a]?|нет|ничего)(?:\s[\p{L}\s,]*)?\.?$|^[-—]+$/iu;
/** «Ничего не пропущено» - короткая фраза; длиннее - уже описание пропуска. */
const NO_OMISSION_MAX_CHARS = 40;

/** Названные пропуски без пустых и без «ничего не пропущено». */
function realOmissions(answer: Pick<SemanticAnswer, 'omissions'>): string[] {
  return answer.omissions
    .map((o) => o.trim())
    .filter((o) => o !== '' && !(o.length <= NO_OMISSION_MAX_CHARS && NO_OMISSION.test(o)));
}

/**
 * Провал смысла: `fail`, неточный образец или названный пропуск (pass с `accurate: false` или
 * с `omissions` противоречит себе: промпт определяет pass как «samples accurate and nothing
 * missing») или потерянное имя из отправленных на проверку; `unsure`, склонение, местоимение и флаги по чужим
 * ключам - не провал (решения арбитра `F05 | F05-5`).
 */
export function semanticFailed(answer: SemanticAnswer, names: readonly NameEntry[]): boolean {
  const sent = new Set(names.map((n) => n.key));
  return (
    answer.verdict === 'fail' ||
    answer.samples.some((s) => !s.accurate) ||
    realOmissions(answer).length > 0 ||
    answer.nameFlags.some((f) => f.verdict === 'lost' && sent.has(f.key))
  );
}

/** Замечания переводчику на повтор: что сказал проверяющий, неточные образцы, пропуски, имена. */
export function semanticRemarks(answer: SemanticAnswer, names: readonly NameEntry[]): string[] {
  const inaccurate = answer.samples
    .filter((s) => !s.accurate)
    .map((s) => `Inaccurate: "${s.source}" is rendered as "${s.translation}".`);
  const lost = answer.nameFlags
    .filter((f) => f.verdict === 'lost')
    .map((f) => names.find((n) => n.key === f.key))
    .filter((n): n is NameEntry => n !== undefined)
    .map((n) => `Keep the name "${n.target}" (source "${n.source}") as the glossary says.`);
  return [
    ...answer.remarks,
    ...inaccurate,
    ...realOmissions(answer).map((o) => `Missing or added: ${o}`),
    ...lost,
  ];
}

/**
 * Неудачи проверки по провалу смысла - замечание на неудачу; проверяющий не дал ни одного -
 * общее замечание. Одно правило на запуск и проверки `F05-6`.
 */
export function semanticFailures(
  answer: SemanticAnswer,
  names: readonly NameEntry[],
): CheckFailure[] {
  const remarks = semanticRemarks(answer, names);
  return (remarks.length > 0 ? remarks : ['The meaning of the source is not kept.']).map(
    (remark) => ({ code: CHECK_FLAG_REASONS.SEMANTIC_FAIL, remark }),
  );
}

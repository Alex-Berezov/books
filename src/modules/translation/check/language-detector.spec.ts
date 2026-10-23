import { Language } from '@prisma/client';
import { corpusChunks, corpusWindows } from '../../../common/testing/language-corpus';
import { DETECTED_LANGUAGES, detectLanguage, foreignShare, sentencesOf } from './language-detector';
import { FOREIGN_SHARE_MAX } from './mechanical-check';

/** Точность и ошибки `es↔pt` на наборе: доля текстов, определённых своим языком. */
function measure(texts: (language: Language) => string[]) {
  let total = 0;
  let correct = 0;
  let esPt = 0;
  for (const language of DETECTED_LANGUAGES) {
    for (const text of texts(language)) {
      total++;
      const found = detectLanguage(text).language;
      if (found === language) correct++;
      if ((language === 'es' && found === 'pt') || (language === 'pt' && found === 'es')) esPt++;
    }
  }
  return { total, accuracy: correct / total, esPt };
}

describe('language detector: measurement on the public-domain corpus (Р3)', () => {
  it('chunks of 1500-3000 words: no es↔pt errors and at least 99 % right', () => {
    // Слово - как у нарезки глав (`split(/\s+/)`): замер Р3 - на кусках той длины, что режет запуск.
    for (const language of DETECTED_LANGUAGES) {
      for (const chunk of corpusChunks(language)) {
        const words = chunk.split(/\s+/).filter(Boolean).length;
        expect(words).toBeGreaterThanOrEqual(1500);
        expect(words).toBeLessThanOrEqual(3000);
      }
    }
    const result = measure(corpusChunks);
    expect(result.total).toBe(150);
    expect(result.esPt).toBe(0);
    expect(result.accuracy).toBeGreaterThanOrEqual(0.99);
  });

  it('windows of 3-5 sentences: at least 95 % right', () => {
    const result = measure(corpusWindows);
    expect(result.total).toBe(150);
    expect(result.accuracy).toBeGreaterThanOrEqual(0.95);
  });

  it('a clean chunk of every language stays under the foreign share threshold', () => {
    for (const language of DETECTED_LANGUAGES) {
      for (const chunk of corpusChunks(language)) {
        expect(foreignShare(chunk, language)).toBeLessThan(FOREIGN_SHARE_MAX);
      }
    }
  });

  it('a Portuguese chunk in a Spanish translation is Portuguese, and foreign as a whole', () => {
    const pt = corpusChunks('pt')[0];
    expect(detectLanguage(pt).language).toBe('pt');
    expect(foreignShare(pt, 'es')).toBeGreaterThan(0.9);
  });

  it('a third of the chunk replaced by Portuguese is over the threshold', () => {
    const es = sentencesOf(corpusChunks('es')[3]);
    const pt = sentencesOf(corpusChunks('pt')[3]);
    const third = Math.floor(es.length / 3);
    const mixed = [...es.slice(0, es.length - third), ...pt.slice(0, third)].join(' ');
    expect(foreignShare(mixed, 'es')).toBeGreaterThanOrEqual(FOREIGN_SHARE_MAX);
  });

  it('names and numbers alone give no language, not a foreign one', () => {
    expect(detectLanguage('Anna 12 Town 1900').language).toBeNull();
    expect(foreignShare('Anna. Town. 1900.', 'es')).toBe(0);
  });

  it('excluded words do not count: a glossary name kept in the original is not foreign', () => {
    const text = 'The old man said that the war was over and that they were home.';
    expect(detectLanguage(text).language).toBe('en');
    const exclude = new Set(['the', 'and', 'that', 'was', 'they', 'were', 'said', 'over']);
    expect(detectLanguage(text, exclude).language).toBeNull();
  });

  it('Cyrillic is Russian', () => {
    expect(
      detectLanguage('Он сказал, что не знает, где она живёт и когда вернётся.').language,
    ).toBe('ru');
  });

  it('sentences split after the end mark with a closing quote', () => {
    expect(sentencesOf('«Да?» Он ушёл. — Нет! Конец…  Ещё')).toEqual([
      '«Да?»',
      'Он ушёл.',
      '— Нет!',
      'Конец…',
      'Ещё',
    ]);
  });
});

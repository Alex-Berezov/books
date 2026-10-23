import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Language } from '@prisma/client';
import { sentencesOf } from '../../modules/translation/check/language-detector';

/**
 * Корпус замера детектора и коридоров длины (`F05-5`, шаг 1): тексты общественного достояния
 * в тестовых фикстурах, не в сиде (сид читает CI фронта). Источники - `README.md` корпуса.
 * Только для спеков: файл компилируется в `dist` вместе с `common/testing`, но зовут его одни
 * спеки - каталога `test/` в образе нет.
 */

const CORPUS_DIR = join(__dirname, '..', '..', '..', 'test', 'fixtures', 'language-corpus');
const SEPARATOR = /\n\s*=====\s*\n/;

function pieces(file: string): string[] {
  return readFileSync(join(CORPUS_DIR, file), 'utf8')
    .split(SEPARATOR)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Куски 1500-3000 слов (счёт нарезки, `split(/\s+/)`) одного языка: 30 из трёх произведений. */
export const corpusChunks = (language: Language): string[] => pieces(`${language}.txt`);

/** Главы Евангелия от Марка: параллельные на пяти языках, одна глава - один элемент. */
export const parallelChapters = (language: Language): string[] => pieces(`mark/${language}.txt`);

/**
 * Окна по 3-5 предложений из кусков языка: с каждого куска - окно из середины, длина окна
 * по кругу 3, 4, 5. Выбор без случайности - замер воспроизводим.
 */
export function corpusWindows(language: Language): string[] {
  return corpusChunks(language).map((chunk, i) => {
    const sentences = sentencesOf(chunk);
    const size = 3 + (i % 3);
    const from = Math.max(0, Math.floor(sentences.length / 2) - size);
    return sentences.slice(from, from + size).join(' ');
  });
}

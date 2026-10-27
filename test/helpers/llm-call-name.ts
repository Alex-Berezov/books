import { DOSSIER_SUMMARY_PROMPT_START } from '../../src/modules/translation/dossier/dossier.prompts';

/** Тело запроса к `/chat/completions`, по которому подменённый OpenRouter узнаёт вызов. */
export interface LlmCallBody {
  response_format?: { json_schema?: { name?: string } };
  messages?: Array<{ role: string; content: string }>;
}

/**
 * Имя вызова для заглушки OpenRouter: имя схемы из `response_format`. Сводка досье уходит
 * без него - схема только в тексте (решение арбитра `F05 | F05-R`, Р1), - и узнаётся по своему
 * системному сообщению.
 */
export function llmCallName(body: LlmCallBody): string {
  const name = body.response_format?.json_schema?.name;
  if (name) return name;
  return body.messages?.[0]?.content.startsWith(DOSSIER_SUMMARY_PROMPT_START) ? 'dossier' : '';
}

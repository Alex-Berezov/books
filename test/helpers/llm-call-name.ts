/** Тело запроса к `/chat/completions`, по которому подменённый OpenRouter узнаёт вызов. */
export interface LlmCallBody {
  response_format?: { json_schema?: { name?: string } };
  messages?: Array<{ role: string; content: string }>;
}

/** Начало системного сообщения сводки досье (`dossierSummaryMessages`). */
const DOSSIER_SUMMARY_PROMPT =
  'You merge partial dossiers of every chapter piece into one book dossier.';

/**
 * Имя вызова для заглушки OpenRouter: имя схемы из `response_format`. Сводка досье уходит
 * без него - схема только в тексте (решение арбитра `F05 | F05-R`, Р1), - и узнаётся по своему
 * системному сообщению.
 */
export function llmCallName(body: LlmCallBody): string {
  const name = body.response_format?.json_schema?.name;
  if (name) return name;
  return body.messages?.[0]?.content.startsWith(DOSSIER_SUMMARY_PROMPT) ? 'dossier' : '';
}

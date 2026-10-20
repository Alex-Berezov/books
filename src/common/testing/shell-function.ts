/**
 * Строки функции bash-скрипта: от её объявления до закрывающей скобки в первой колонке
 * включительно; скобки нет — до конца файла. Функции нет — пустой массив.
 *
 * ⚠️ Строки внутри heredoc пропускаются. В `save_current_state` (`scripts/deploy_production.sh`)
 * есть `cat > ... << EOF` с JSON-телом, и закрывающая скобка этого JSON стоит в первой
 * колонке — то есть выглядит ровно как конец функции. Разбор обрывался на ней, на четыре
 * строки раньше настоящего конца, и проверка на хвост функции молча читала пустоту (`L-008`).
 *
 * Живёт в общем месте, а не копией в каждой спеке скриптов: вторая копия однажды уже
 * появилась без этой починки, и две спеки одного скрипта считали конец функции по-разному.
 */
export const shellFunctionLines = (lines: readonly string[], name: string): string[] => {
  const start = lines.findIndex((line) => line.startsWith(`${name}()`));
  if (start === -1) return [];

  let heredoc: string | null = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (heredoc !== null) {
      if (line.trim() === heredoc) heredoc = null;
      continue;
    }
    // Комментарий, цитирующий `cat > f << EOF`, и here-string `<<<` heredoc не открывают:
    // иначе разбор ушёл бы искать `EOF` до конца файла.
    if (/^\s*#/.test(line)) continue;
    const opened = line.match(/(?:^|[^<])<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/);
    if (opened) {
      heredoc = opened[1];
      continue;
    }
    if (line === '}') return lines.slice(start, i + 1);
  }

  return lines.slice(start);
};

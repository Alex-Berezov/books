import { shellFunctionLines } from './shell-function';

describe('shellFunctionLines', () => {
  it('скобка JSON внутри heredoc не обрывает функцию', () => {
    const lines = ['f() {', '  cat << EOF', '{', '}', 'EOF', '  echo done', '}', 'g() {', '}'];
    expect(shellFunctionLines(lines, 'f')).toEqual(lines.slice(0, 7));
  });

  it('делимитер в двойных кавычках тоже открывает heredoc', () => {
    const lines = ['f() {', '  cat << "EOF"', '{', '}', 'EOF', '}', 'g() {', '}'];
    expect(shellFunctionLines(lines, 'f')).toEqual(lines.slice(0, 6));
  });

  it('комментарий с `<< EOF` и here-string `<<<` heredoc не открывают', () => {
    const lines = ['f() {', '  # cat > "$FILE" << EOF', '  read x <<< "$y"', '}', 'g() {', '}'];
    expect(shellFunctionLines(lines, 'f')).toEqual(lines.slice(0, 4));
  });

  it('функции нет — пустой массив', () => {
    expect(shellFunctionLines(['g() {', '}'], 'f')).toEqual([]);
  });
});

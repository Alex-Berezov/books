/**
 * Значения, которые поле ссылки из данных обязано отбить (`LEGACY-447`): попав в `href`,
 * они исполняются по клику на сайте или в админке либо уводят не туда.
 */
export const NON_HTTP_URLS = [
  'javascript:alert(1)',
  'JavaScript:alert(document.cookie)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'ftp://example.com/file.pdf',
  // Без `://`: `isURL` без обязательной схемы читает `javascript` как хост, `1` как порт.
  'javascript:1/alert(1)//',
];

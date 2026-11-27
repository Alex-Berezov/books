/**
 * Эталон страницы понятия языка `pt` - копия `test/fixtures/example-world-term.pt.json` (канон
 * `features/F08-book-wiki/prompts/example-world-term.pt.json`): образец формы понятия в промпте шага
 * понятия хода мира `F08-13b`. Равенство с копией JSON держит `examples.spec.ts`. Правится только вместе с ней.
 */
export const EXAMPLE_WORLD_TERM_PT: Record<string, unknown> = {
  language: 'pt',
  entities: [
    {
      key: 'pledge',
      type: 'term',
      name: 'Penhor',
      short:
        'Objeto deixado com um penhorista como garantia do dinheiro emprestado: se a dívida não for paga no prazo, o objeto fica com quem emprestou. No romance, Raskólnikov empenha suas coisas com a velha agiota Aliona Ivánovna.',
      significance:
        'O penhor é o meio de Raskólnikov entrar no apartamento da agiota. No capítulo 1 ele lhe leva um relógio de prata e observa os cômodos e o modo como ela abre a porta; no capítulo 6 prepara um penhor falso, uma tabuinha embrulhada tão apertada que ela vai demorar a desatá-la.',
      quotes: [
        {
          text: 'O penhor, porém, não era penhor nenhum, mas uma simples tabuinha de madeira bem aplainada, do tamanho e da espessura que teria uma cigarreira de prata.',
          chapter: 6,
          interpretation:
            'O penhor falso tem um só propósito: manter a agiota ocupada com o nó durante o instante de que Raskólnikov precisa.',
        },
      ],
    },
  ],
};

/**
 * Эталон страницы понятия языка `en` - копия `test/fixtures/example-world-term.en.json` (канон
 * `features/F08-book-wiki/prompts/example-world-term.en.json`): образец формы понятия в промпте шага
 * понятия хода мира `F08-13b`. Равенство с копией JSON держит `examples.spec.ts`. Правится только вместе с ней.
 */
export const EXAMPLE_WORLD_TERM_EN: Record<string, unknown> = {
  language: 'en',
  entities: [
    {
      key: 'pledge',
      type: 'term',
      name: 'Pledge',
      short:
        'A thing left with a pawnbroker as security for money lent: if the debt is not repaid on time, the thing stays with the lender. In the novel Raskolnikov pawns his things with the old pawnbroker Alyona Ivanovna.',
      significance:
        'The pledge is Raskolnikov’s way into the pawnbroker’s flat. In chapter 1 he brings her a silver watch and studies the rooms and the way she opens the door; in chapter 6 he prepares a false pledge, a piece of wood wrapped so tightly that it will take her time to untie it.',
      quotes: [
        {
          text: 'The pledge, however, was nothing but a smooth piece of wood planed to the size and thickness of a silver cigarette case.',
          chapter: 6,
          interpretation:
            'The false pledge is made for one purpose: to keep the pawnbroker busy with the knot for the moment Raskolnikov needs.',
        },
      ],
    },
  ],
};

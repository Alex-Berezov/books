/**
 * Эталон страницы предмета языка `en` - копия `test/fixtures/example-world-object.en.json` (канон
 * `features/F08-book-wiki/prompts/example-world-object.en.json`): образец формы предмета в промпте шага
 * предмета хода мира `F08-13b`. Равенство с копией JSON держит `examples.spec.ts`. Правится только вместе с ней.
 */
export const EXAMPLE_WORLD_OBJECT_EN: Record<string, unknown> = {
  language: 'en',
  entities: [
    {
      key: 'axe',
      type: 'object',
      name: 'The axe',
      short:
        'The axe that Raskolnikov takes for the deed he has been planning for a month. He means to take it from his landlady’s kitchen, and when that fails he finds it by chance in the porter’s room.',
      significance:
        'The axe can be read as the point where the idea becomes a deed. For a whole month Raskolnikov thinks his plan over in the garret, but in chapter 6 it all comes down to a household tool: where to take it, how to carry it, how to hide it under his coat. The scale of the theory and the trifle of the axe stand side by side, and the trifle decides everything.\n\nThe axe also shows how much in the plan depends on chance. The kitchen he counted on is not empty, the plan seems to collapse, and the axe turns up under the bench in the porter’s room. Raskolnikov takes it as a sign: what his reason could not arrange, the chance has arranged for him.',
      description:
        'An ordinary household axe. Raskolnikov does not carry it in his hand: in chapter 6 he tears a strip from an old unwashed shirt and sews it inside his summer overcoat as a loop under the left armpit, so that the axe hangs in it and the coat hides it. He finds the axe in the porter’s room, under the bench, between two logs.',
      quotes: [
        {
          text: '“When reason fails, the devil helps!” he thought with a strange grin.',
          chapter: 6,
          speakerKey: 'raskolnikov',
          interpretation:
            'Raskolnikov finds the axe by chance after the plan with the kitchen has failed. He explains the luck not by his reason but by the devil, and the grin shows that he himself senses something wrong in it.',
        },
        {
          text: 'He pulled the axe quite out, swung it with both arms, scarcely conscious of himself, and almost without effort, almost mechanically, brought the blunt side down on her head.',
          chapter: 7,
          interpretation:
            'The deed is done “almost mechanically”: the long reasoning of the previous chapters ends in a movement in which Raskolnikov hardly feels himself.',
        },
      ],
      faq: [
        {
          question: 'Where did Raskolnikov get the axe?',
          answer:
            'In the porter’s room (chapter 6). He meant to take it from the landlady’s kitchen, but Nastasya was there; on the way out he saw the axe under the bench in the porter’s room and took it.',
        },
        {
          question: 'How did Raskolnikov hide the axe?',
          answer:
            'In a loop he sewed inside his overcoat under the left armpit from a strip of an old shirt (chapter 6): the axe hung in it, and the coat covered it.',
        },
      ],
      characterKeys: ['raskolnikov'],
      themeKeys: ['guilt'],
    },
  ],
};

/**
 * Эталон страницы события языка `en` - копия `test/fixtures/example-world-event.en.json` (канон
 * `features/F08-book-wiki/prompts/example-world-event.en.json`): образец формы события в промпте шага
 * события хода мира `F08-13b-2`. Равенство с копией JSON держит `examples.spec.ts`. Правится только вместе с ней.
 */
export const EXAMPLE_WORLD_EVENT_EN: Record<string, unknown> = {
  language: 'en',
  entities: [
    {
      key: 'taking-the-axe',
      type: 'event',
      name: 'Taking the axe',
      short:
        'On the day he has chosen, Raskolnikov goes down to the landlady’s kitchen for the axe he has counted on. Nastasya is in the kitchen, and the whole plan hangs by a thread.',
      significance:
        'The episode can be read as the moment when the plan meets the real world. For a month the deed existed only in thought; in chapter 6 it depends on a trifle: where to get a tool and how to carry it. Raskolnikov has counted on an empty kitchen, and when Nastasya is there, the whole plan seems to fall apart.\n\nThe way out comes by chance, and this is what the episode shows: he does not reach the axe by calculation. He takes the luck as a sign, and the reader sees how much of the “idea” is made of coincidences that Raskolnikov chooses to read as fate.',
      scenes: [
        {
          chapter: 6,
          title: 'The kitchen is not empty',
          text: 'Raskolnikov goes down to the landlady’s kitchen to take the axe. Nastasya is in the kitchen, and his calculation collapses in an instant.',
        },
        {
          chapter: 6,
          title: 'The porter’s room',
          text: 'On the way out he looks into the porter’s room and sees an axe lying under the bench between two logs. He takes it, hides it under his coat and goes out.',
        },
      ],
      quotes: [
        {
          text: '“When reason fails, the devil helps!” he thought with a strange grin.',
          chapter: 6,
          speakerKey: 'raskolnikov',
          interpretation:
            'Raskolnikov finds the axe by chance after the plan with the kitchen has failed. He explains the luck not by his reason but by the devil, and the grin shows that he himself senses something wrong in it.',
        },
      ],
      characterKeys: ['raskolnikov'],
    },
  ],
};

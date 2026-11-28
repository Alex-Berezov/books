/**
 * Эталон страницы события языка `fr` - копия `test/fixtures/example-world-event.fr.json` (канон
 * `features/F08-book-wiki/prompts/example-world-event.fr.json`): образец формы события в промпте шага
 * события хода мира `F08-13b-2`. Равенство с копией JSON держит `examples.spec.ts`. Правится только вместе с ней.
 */
export const EXAMPLE_WORLD_EVENT_FR: Record<string, unknown> = {
  language: 'fr',
  entities: [
    {
      key: 'taking-the-axe',
      type: 'event',
      name: 'La prise de la hache',
      short:
        'Le jour choisi, Raskolnikov descend à la cuisine de la logeuse chercher la hache sur laquelle il comptait. Nastassia est dans la cuisine, et tout le projet ne tient plus qu’à un fil.',
      significance:
        'L’épisode peut se lire comme le moment où le projet rencontre la réalité. Pendant un mois l’acte n’a existé que dans la pensée ; au chapitre 6, tout dépend d’un détail : où trouver l’outil et comment le porter. Raskolnikov comptait sur une cuisine vide, et quand Nastassia s’y trouve, tout le plan semble s’effondrer.\n\nLa solution vient par hasard, et c’est ce que montre l’épisode : il n’arrive pas à la hache par calcul. Il prend la chance pour un signe, et le lecteur voit combien l’« idée » est faite de coïncidences que Raskolnikov choisit de lire comme un destin.',
      scenes: [
        {
          chapter: 6,
          title: 'La cuisine n’est pas vide',
          text: 'Raskolnikov descend à la cuisine de la logeuse pour prendre la hache. Nastassia est dans la cuisine, et son calcul s’effondre en un instant.',
        },
        {
          chapter: 6,
          title: 'La loge du concierge',
          text: 'En sortant, il jette un coup d’œil dans la loge du concierge et voit une hache sous le banc, entre deux bûches. Il la prend, la cache sous son manteau et sort dans la rue.',
        },
      ],
      quotes: [
        {
          text: "« Si ce n'est pas la raison, c'est le démon ! » pensa-t-il avec un sourire étrange.",
          chapter: 6,
          speakerKey: 'raskolnikov',
          interpretation:
            'Raskolnikov trouve la hache par hasard, une fois le plan de la cuisine échoué. Il explique la chance non par sa raison mais par le démon, et le sourire montre qu’il sent lui-même quelque chose de faussé.',
        },
      ],
      characterKeys: ['raskolnikov'],
    },
  ],
};

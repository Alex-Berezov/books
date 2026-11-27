/**
 * Эталон страницы понятия языка `fr` - копия `test/fixtures/example-world-term.fr.json` (канон
 * `features/F08-book-wiki/prompts/example-world-term.fr.json`): образец формы понятия в промпте шага
 * понятия хода мира `F08-13b`. Равенство с копией JSON держит `examples.spec.ts`. Правится только вместе с ней.
 */
export const EXAMPLE_WORLD_TERM_FR: Record<string, unknown> = {
  language: 'fr',
  entities: [
    {
      key: 'pledge',
      type: 'term',
      name: 'Gage',
      short:
        'Objet laissé à un prêteur sur gages en garantie de l’argent emprunté : si la dette n’est pas rendue à temps, l’objet reste au prêteur. Dans le roman, Raskolnikov met ses affaires en gage chez la vieille usurière Aliona Ivanovna.',
      significance:
        'Le gage est le moyen pour Raskolnikov d’entrer chez l’usurière. Au chapitre 1, il lui apporte une montre en argent et observe les pièces et la façon dont elle ouvre la porte ; au chapitre 6, il prépare un faux gage, une planchette emballée si serré qu’il lui faudra du temps pour la défaire.',
      quotes: [
        {
          text: 'Le gage, du reste, n’était pas du tout un gage, mais une simple planchette de bois bien rabotée, pas plus grande ni plus épaisse que ne l’aurait été un porte-cigarettes en argent.',
          chapter: 6,
          interpretation:
            'Le faux gage n’a qu’un but : occuper l’usurière avec le nœud pendant l’instant dont Raskolnikov a besoin.',
        },
      ],
    },
  ],
};

/**
 * Эталон страницы предмета языка `es` - копия `test/fixtures/example-world-object.es.json` (канон
 * `features/F08-book-wiki/prompts/example-world-object.es.json`): образец формы предмета в промпте шага
 * предмета хода мира `F08-13b`. Равенство с копией JSON держит `examples.spec.ts`. Правится только вместе с ней.
 */
export const EXAMPLE_WORLD_OBJECT_ES: Record<string, unknown> = {
  language: 'es',
  entities: [
    {
      key: 'axe',
      type: 'object',
      name: 'El hacha',
      short:
        'El hacha que Raskólnikov toma para el acto que planea desde hace un mes. Cuenta con sacarla de la cocina de su patrona y, cuando eso falla, la encuentra por casualidad en el cuarto del portero.',
      significance:
        'El hacha puede leerse como el punto en que la idea se convierte en acto. Durante un mes entero Raskólnikov da vueltas a su plan en el cuartucho, pero en el capítulo 6 todo se reduce a una herramienta doméstica: dónde conseguirla, cómo llevarla, cómo ocultarla bajo el abrigo. La magnitud de la teoría y la nimiedad del hacha están una junto a otra, y decide la nimiedad.\n\nEl hacha muestra también cuánto del plan depende del azar. La cocina con la que contaba no está vacía, el plan parece derrumbarse, y el hacha aparece bajo el banco del cuarto del portero. Raskólnikov lo toma como una señal: lo que su razón no logró, el azar lo arregló por él.',
      description:
        'Un hacha doméstica corriente. Raskólnikov no la lleva en la mano: en el capítulo 6 arranca una tira de una vieja camisa sin lavar y la cose por dentro de su abrigo de verano como un lazo bajo la axila izquierda, para que el hacha cuelgue de él y el abrigo la oculte. La encuentra en el cuarto del portero, bajo el banco, entre dos leños.',
      quotes: [
        {
          text: '«¡Si no es la razón, será el demonio!», pensó, sonriendo de un modo extraño.',
          chapter: 6,
          speakerKey: 'raskolnikov',
          interpretation:
            'Raskólnikov encuentra el hacha por casualidad, después de que el plan de la cocina ha fracasado. No atribuye la suerte a su razón sino al diablo, y la sonrisa delata que él mismo siente algo turbio en ello.',
        },
        {
          text: 'Sacó el hacha del todo, la levantó con ambas manos, casi sin sentirse a sí mismo, y casi sin esfuerzo, casi maquinalmente, la dejó caer de lomo sobre su cabeza.',
          chapter: 7,
          interpretation:
            'El acto se cumple «casi maquinalmente»: los largos razonamientos de los capítulos anteriores terminan en un movimiento en el que Raskólnikov apenas se siente a sí mismo.',
        },
      ],
      faq: [
        {
          question: '¿De dónde sacó Raskólnikov el hacha?',
          answer:
            'Del cuarto del portero (capítulo 6). Pensaba tomarla de la cocina de la patrona, pero allí estaba Nastasia; al salir vio el hacha bajo el banco del cuarto del portero y se la llevó.',
        },
        {
          question: '¿Cómo escondió Raskólnikov el hacha?',
          answer:
            'En un lazo que cosió por dentro del abrigo, bajo la axila izquierda, con una tira de una camisa vieja (capítulo 6): el hacha colgaba de él y el abrigo la tapaba.',
        },
      ],
      characterKeys: ['raskolnikov'],
      themeKeys: ['guilt'],
    },
  ],
};

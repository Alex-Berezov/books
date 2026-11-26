/**
 * Эталон страницы места языка `fr` - копия `test/fixtures/example-world-place.fr.json` (канон
 * `features/F08-book-wiki/prompts/example-world-place.fr.json`): образец формы места в промпте шага
 * места хода мира `F08-12b`. Равенство с копией JSON держит `examples.spec.ts`. Правится только вместе с ней.
 */
export const EXAMPLE_WORLD_PLACE_FR: Record<string, unknown> = {
  language: 'fr',
  entities: [
    {
      key: 'raskolnikovs-garret',
      type: 'place',
      name: 'La mansarde de Raskolnikov',
      short:
        'Une pièce minuscule sous le toit même d’une haute maison de cinq étages, dans la ruelle S., à Pétersbourg, que Raskolnikov loue à sa logeuse et qu’il ne paie plus. Plus semblable à un placard qu’à un logement, c’est là qu’il reste couché des journées entières seul avec son idée, et là qu’il se prépare à l’acte.',
      kind: 'fictional',
      location:
        'Pétersbourg, ruelle S. : sous le toit d’une haute maison de cinq étages, un étage au-dessus du logement de la logeuse ; sept cent trente pas séparent la porte cochère de la maison de celle de l’usurière.',
      significance:
        'La mansarde peut se lire comme la forme de l’isolement de Raskolnikov. Il s’y est enfermé loin de tous, et l’idée y grandit sans obstacle : personne n’y entre, sauf Nastassia, la servante de la logeuse. Étroite, basse et poussiéreuse, la pièce épouse l’état de son locataire : au chapitre 3, après la lettre de sa mère, il étouffe dans cette mansarde jaune pareille à un placard et sort dans la rue.\n\nLa mansarde lie aussi le projet au quotidien : pour gagner l’escalier, il doit passer devant la cuisine ouverte de la logeuse, il se cache d’elle à cause de sa dette, et c’est justement dans cette cuisine qu’il compte prendre la hache. La peur de croiser une logeuse, à côté de l’ampleur de ce qu’il projette, est le premier contraste du roman.',
      description:
        'Dostoïevski décrit la pièce deux fois. Au chapitre 1, c’est une mansarde sous le toit même, plus semblable à un placard qu’à un logement ; la logeuse qui lui loue la pièce avec les repas et le service habite un étage plus bas, et la porte de sa cuisine reste toujours ouverte sur l’escalier. Au chapitre 3, le narrateur la montre de l’intérieur : un réduit minuscule d’environ six pas de long, au papier jaunâtre et poussiéreux décollé des murs, si bas qu’un homme de grande taille s’y sent mal à l’aise et craint de se cogner la tête au plafond. Trois vieilles chaises boiteuses, une table peinte dans un coin avec des livres et des cahiers sous une épaisse poussière, et un grand divan disgracieux tendu d’une indienne en lambeaux, qui occupe presque tout un mur et lui sert de lit : il y dort sans se déshabiller, couvert de son vieux manteau d’étudiant.',
      scenes: [
        {
          chapter: 1,
          title: 'Devant la cuisine de la logeuse',
          text: 'Raskolnikov sort de sa mansarde et descend l’escalier à pas de loup devant la cuisine ouverte de la logeuse pour ne pas la rencontrer : il lui doit de l’argent. Il a honte de cette peur, car il part répéter quelque chose de bien plus terrible.',
        },
        {
          chapter: 3,
          title: 'Le matin dans la mansarde',
          text: 'Nastassia lui apporte du thé, lui apprend que la logeuse veut porter plainte à la police et lui remet la lettre de sa mère. Il la lit dans la mansarde, puis la pièce lui paraît si étouffante qu’il sort errer dans les rues.',
        },
        {
          chapter: 6,
          title: 'Les préparatifs',
          text: 'Dans la mansarde, il coud à l’intérieur de son manteau une boucle pour la hache et prend le faux gage qu’il a préparé. Il compte prendre la hache dans la cuisine de la logeuse, mais Nastassia s’y trouve, et le projet manque de s’effondrer pour une bagatelle.',
        },
      ],
      quotes: [
        {
          text: 'Sa mansarde se trouvait sous le toit même d’une haute maison de cinq étages et ressemblait plus à un placard qu’à un logement.',
          chapter: 1,
          interpretation:
            'Le premier mot du narrateur sur l’endroit où vit le héros. Une pièce pareille à « un placard » est la mesure de sa misère et de son enfermement : l’idée qui y grandit n’a nulle part où aller.',
        },
      ],
      faq: [
        {
          question: 'Où habite Raskolnikov ?',
          answer:
            'Dans une mansarde sous le toit d’une haute maison de cinq étages, dans la ruelle S., à Pétersbourg (chapitre 1). Il la loue à une logeuse qui habite un étage plus bas et à qui il doit le loyer ; dans l’escalier, il se cache d’elle.',
        },
        {
          question: 'À quoi ressemble la mansarde de Raskolnikov ?',
          answer:
            'Le chapitre 3 la décrit : environ six pas de long, si basse qu’un homme de grande taille s’y sent mal à l’aise, avec un papier jaune et poussiéreux qui se décolle, trois vieilles chaises, une table poussiéreuse et un grand divan en lambeaux qui lui sert de lit.',
        },
      ],
      imageBrief:
        "Wide 16:9 illustration, at least 1200 px wide, of Raskolnikov's garret from the novel Crime and Punishment by Fyodor Dostoevsky. A tiny room under the very roof, more like a cupboard than a room: about six paces long and so low that a tall man feels he may knock his head against the ceiling; dusty yellow wallpaper peeling off the walls; three rickety old chairs; a painted table in the corner with books and papers under thick dust; a large clumsy sofa in ragged chintz taking up almost a whole wall, an old student's overcoat thrown over it. Mid-nineteenth-century Petersburg, an exceptionally hot early July, poverty and neglect. No people with recognisable faces, no faces of real actors, no stills of film or stage adaptations, no style of a recognisable artist; no text, lettering or watermarks.",
    },
  ],
};

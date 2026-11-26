/**
 * Эталон страницы места языка `en` - копия `test/fixtures/example-world-place.en.json` (канон
 * `features/F08-book-wiki/prompts/example-world-place.en.json`): образец формы места в промпте шага
 * места хода мира `F08-12b`. Равенство с копией JSON держит `examples.spec.ts`. Правится только вместе с ней.
 */
export const EXAMPLE_WORLD_PLACE_EN: Record<string, unknown> = {
  language: 'en',
  entities: [
    {
      key: 'raskolnikovs-garret',
      type: 'place',
      name: 'Raskolnikov’s garret',
      short:
        'A tiny room under the roof of a tall five-storey house in S. Place in Petersburg, which Raskolnikov rents from his landlady and has not paid for. More like a cupboard than a room, it is where he lies for days on end alone with his idea, and where he prepares for the deed.',
      kind: 'fictional',
      location:
        'Petersburg, S. Place: under the roof of a tall five-storey house, a floor above the landlady’s flat; seven hundred and thirty steps from the gate of the house to the pawnbroker’s.',
      significance:
        'The garret can be read as the shape of Raskolnikov’s isolation. He has shut himself away from everyone in it, and the idea grows there unhindered: no one comes in except the landlady’s servant Nastasya. Cramped, low and dusty, the room matches the state of its tenant: in chapter 3, after his mother’s letter, he feels stifled in this yellow cupboard of a room and goes out into the street.\n\nThe garret also ties his plan to the everyday: to reach the stairs he must pass the landlady’s open kitchen, he hides from her because of his debt, and it is from that kitchen that he means to take the axe. The fear of meeting a landlady, set beside the scale of what he is planning, is the first contrast of the novel.',
      description:
        'Dostoevsky describes the room twice. In chapter 1 it is a garret under the very roof, more like a cupboard than a room; the landlady who provides him with dinners and attendance lives a floor below, and her kitchen door always stands open onto the stairs. In chapter 3 the narrator shows the inside: a tiny cell about six paces long, with dusty yellow wallpaper peeling off the walls, so low that a tall man feels he may knock his head against the ceiling. Three rickety old chairs, a painted table in the corner with books and papers under thick dust, and a large clumsy sofa in ragged chintz that takes up almost a whole wall and serves Raskolnikov as a bed: he often sleeps on it without undressing, covered with his old student’s overcoat.',
      scenes: [
        {
          chapter: 1,
          title: 'Slipping past the landlady',
          text: 'Raskolnikov leaves his garret and creeps down the stairs past the landlady’s open kitchen so as not to meet her: he owes her money. He is ashamed of this fear, because he is setting out to rehearse something far more terrible.',
        },
        {
          chapter: 3,
          title: 'Morning in the garret',
          text: 'Nastasya brings tea and tells him the landlady means to complain to the police, then hands him his mother’s letter. He reads it in the garret, and afterwards the room seems so stifling that he goes out to wander the streets.',
        },
        {
          chapter: 6,
          title: 'Preparing for the deed',
          text: 'In the garret he sews a loop for the axe inside his coat and takes the false pledge he has prepared. He means to take the axe from the landlady’s kitchen, but Nastasya is there, and his plan nearly collapses on a trifle.',
        },
      ],
      quotes: [
        {
          text: 'His garret was under the roof of a high, five-storied house and was more like a cupboard than a room.',
          chapter: 1,
          interpretation:
            'The narrator’s first word about where the hero lives. A room “more like a cupboard” is the measure of his poverty and of his seclusion: the idea that grows in it has nowhere to turn.',
        },
      ],
      faq: [
        {
          question: 'Where does Raskolnikov live?',
          answer:
            'In a garret under the roof of a tall five-storey house in S. Place in Petersburg (chapter 1). He rents it from a landlady who lives a floor below and whom he owes for the room; he hides from her on the stairs.',
        },
        {
          question: 'What does Raskolnikov’s garret look like?',
          answer:
            'Chapter 3 describes it: about six paces long, so low that a tall man is ill at ease in it, with dusty yellow wallpaper peeling off, three old chairs, a dusty table and a large ragged sofa that serves him as a bed.',
        },
      ],
      imageBrief:
        "Wide 16:9 illustration, at least 1200 px wide, of Raskolnikov's garret from the novel Crime and Punishment by Fyodor Dostoevsky. A tiny room under the very roof, more like a cupboard than a room: about six paces long and so low that a tall man feels he may knock his head against the ceiling; dusty yellow wallpaper peeling off the walls; three rickety old chairs; a painted table in the corner with books and papers under thick dust; a large clumsy sofa in ragged chintz taking up almost a whole wall, an old student's overcoat thrown over it. Mid-nineteenth-century Petersburg, an exceptionally hot early July, poverty and neglect. No people with recognisable faces, no faces of real actors, no stills of film or stage adaptations, no style of a recognisable artist; no text, lettering or watermarks.",
    },
  ],
};

/**
 * Эталон страницы места языка `pt` - копия `test/fixtures/example-world-place.pt.json` (канон
 * `features/F08-book-wiki/prompts/example-world-place.pt.json`): образец формы места в промпте шага
 * места хода мира `F08-12b`. Равенство с копией JSON держит `examples.spec.ts`. Правится только вместе с ней.
 */
export const EXAMPLE_WORLD_PLACE_PT: Record<string, unknown> = {
  language: 'pt',
  entities: [
    {
      key: 'raskolnikovs-garret',
      type: 'place',
      name: 'O cubículo de Raskólnikov',
      short:
        'Um quarto minúsculo bem debaixo do telhado de um alto prédio de cinco andares na travessa S., em São Petersburgo, que Raskólnikov aluga da senhoria e não paga. Mais parecido com um armário do que com uma moradia, é ali que ele passa dias inteiros deitado, sozinho com a sua ideia, e ali que se prepara para o crime.',
      kind: 'fictional',
      location:
        'São Petersburgo, travessa S.: debaixo do telhado de um alto prédio de cinco andares, um andar acima da moradia da senhoria; do portão do prédio até a casa da usurária são setecentos e trinta passos.',
      significance:
        'O cubículo pode ser lido como a forma do isolamento de Raskólnikov. Ele se trancou ali longe de todos, e a ideia cresce sem obstáculo: ninguém entra, a não ser Nastácia, a criada da senhoria. Apertado, baixo e empoeirado, o quarto coincide com o estado do inquilino: no capítulo 3, depois da carta da mãe, ele se sente sufocar naquele cubículo amarelo parecido com um armário e sai para a rua.\n\nO cubículo também prende o plano ao cotidiano: para chegar à escada, ele precisa passar pela cozinha aberta da senhoria, esconde-se dela por causa da dívida, e é justamente dessa cozinha que pretende tirar o machado. O medo de topar com a senhoria, ao lado da dimensão do que ele planeja, é o primeiro contraste do romance.',
      description:
        'Dostoiévski descreve o quarto duas vezes. No capítulo 1 é um cubículo bem debaixo do telhado, mais parecido com um armário do que com uma moradia; a senhoria, que lhe aluga o quarto com refeições e serviço, mora um andar abaixo, e a porta da cozinha dela fica sempre aberta para a escada. No capítulo 3 o narrador o mostra por dentro: uma cela minúscula de uns seis passos de comprimento, com um papel de parede amarelado e empoeirado descolando das paredes, tão baixa que um homem alto se sente pouco à vontade e teme bater a cabeça no teto. Três cadeiras velhas e bambas, uma mesa pintada num canto com livros e cadernos sob uma grossa camada de poeira e um sofá grande e desajeitado, forrado de chita em farrapos, que ocupa quase uma parede inteira e lhe serve de cama: ele dorme ali sem se despir, coberto com o seu velho capote de estudante.',
      scenes: [
        {
          chapter: 1,
          title: 'Diante da cozinha da senhoria',
          text: 'Raskólnikov sai do cubículo e desce a escada às escondidas diante da cozinha aberta da senhoria para não encontrá-la: ele lhe deve dinheiro. Envergonha-se desse medo, porque está indo ensaiar algo muito mais terrível.',
        },
        {
          chapter: 3,
          title: 'A manhã no cubículo',
          text: 'Nastácia lhe traz chá, conta que a senhoria quer se queixar à polícia e lhe entrega a carta da mãe. Ele a lê no cubículo, e depois o quarto lhe parece tão abafado que ele sai para vagar pelas ruas.',
        },
        {
          chapter: 6,
          title: 'Os preparativos',
          text: 'No cubículo ele costura por dentro do casaco uma alça para o machado e pega o falso penhor que havia preparado. Pretende tirar o machado da cozinha da senhoria, mas Nastácia está lá, e o plano quase desmorona por uma ninharia.',
        },
      ],
      quotes: [
        {
          text: 'Seu cubículo ficava bem debaixo do telhado de um alto prédio de cinco andares e parecia mais um armário do que uma moradia.',
          chapter: 1,
          interpretation:
            'A primeira palavra do narrador sobre onde o herói mora. Um quarto parecido com «um armário» é a medida da sua pobreza e do seu isolamento: a ideia que cresce nele não tem para onde ir.',
        },
      ],
      faq: [
        {
          question: 'Onde mora Raskólnikov?',
          answer:
            'Num cubículo debaixo do telhado de um alto prédio de cinco andares na travessa S., em São Petersburgo (capítulo 1). Ele o aluga de uma senhoria que mora um andar abaixo e a quem deve o aluguel; na escada, ele se esconde dela.',
        },
        {
          question: 'Como é o cubículo de Raskólnikov?',
          answer:
            'O capítulo 3 o descreve: uns seis passos de comprimento, tão baixo que um homem alto se sente pouco à vontade, com o papel de parede amarelo e empoeirado descolando, três cadeiras velhas, uma mesa empoeirada e um grande sofá esfarrapado que lhe serve de cama.',
        },
      ],
      imageBrief:
        "Wide 16:9 illustration, at least 1200 px wide, of Raskolnikov's garret from the novel Crime and Punishment by Fyodor Dostoevsky. A tiny room under the very roof, more like a cupboard than a room: about six paces long and so low that a tall man feels he may knock his head against the ceiling; dusty yellow wallpaper peeling off the walls; three rickety old chairs; a painted table in the corner with books and papers under thick dust; a large clumsy sofa in ragged chintz taking up almost a whole wall, an old student's overcoat thrown over it. Mid-nineteenth-century Petersburg, an exceptionally hot early July, poverty and neglect. No people with recognisable faces, no faces of real actors, no stills of film or stage adaptations, no style of a recognisable artist; no text, lettering or watermarks.",
    },
  ],
};

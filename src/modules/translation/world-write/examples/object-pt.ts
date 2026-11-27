/**
 * Эталон страницы предмета языка `pt` - копия `test/fixtures/example-world-object.pt.json` (канон
 * `features/F08-book-wiki/prompts/example-world-object.pt.json`): образец формы предмета в промпте шага
 * предмета хода мира `F08-13b`. Равенство с копией JSON держит `examples.spec.ts`. Правится только вместе с ней.
 */
export const EXAMPLE_WORLD_OBJECT_PT: Record<string, unknown> = {
  language: 'pt',
  entities: [
    {
      key: 'axe',
      type: 'object',
      name: 'O machado',
      short:
        'O machado que Raskólnikov leva para o ato que planeja há um mês. Ele conta tirá-lo da cozinha da senhoria e, quando isso falha, encontra-o por acaso no quarto do porteiro.',
      significance:
        'O machado pode ser lido como o ponto em que a ideia vira ato. Durante um mês inteiro Raskólnikov remói o plano no cubículo, mas no capítulo 6 tudo se reduz a uma ferramenta doméstica: onde pegá-la, como levá-la, como escondê-la sob o casaco. A grandeza da teoria e a miudeza do machado ficam lado a lado, e quem decide é a miudeza.\n\nO machado mostra também o quanto o plano depende do acaso. A cozinha com que ele contava não está vazia, o plano parece desabar, e o machado aparece debaixo do banco do quarto do porteiro. Raskólnikov toma isso como um sinal: o que a razão não conseguiu arranjar, o acaso arranjou por ele.',
      description:
        'Um machado doméstico comum. Raskólnikov não o leva na mão: no capítulo 6 ele arranca uma tira de uma velha camisa por lavar e a costura por dentro do sobretudo de verão como uma alça debaixo da axila esquerda, para que o machado fique pendurado nela e o casaco o esconda. Ele o encontra no quarto do porteiro, debaixo do banco, entre duas achas de lenha.',
      quotes: [
        {
          text: '“Se não é a razão, é o demônio!”, pensou ele, sorrindo de um modo estranho.',
          chapter: 6,
          speakerKey: 'raskolnikov',
          interpretation:
            'Raskólnikov encontra o machado por acaso, depois que o plano da cozinha fracassou. Ele atribui a sorte não à razão, mas ao diabo, e o sorriso revela que ele mesmo sente algo de errado nisso.',
        },
        {
          text: 'Tirou o machado de vez, ergueu-o com as duas mãos, mal se sentindo a si mesmo, e quase sem esforço, quase maquinalmente, baixou-o com o lado cego sobre a cabeça dela.',
          chapter: 7,
          interpretation:
            'O ato se cumpre “quase maquinalmente”: os longos raciocínios dos capítulos anteriores terminam num gesto em que Raskólnikov mal se sente a si mesmo.',
        },
      ],
      faq: [
        {
          question: 'Onde Raskólnikov pegou o machado?',
          answer:
            'No quarto do porteiro (capítulo 6). Ele pretendia tirá-lo da cozinha da senhoria, mas Nastácia estava lá; ao sair, viu o machado debaixo do banco do quarto do porteiro e o levou.',
        },
        {
          question: 'Como Raskólnikov escondeu o machado?',
          answer:
            'Numa alça que costurou por dentro do sobretudo, debaixo da axila esquerda, com uma tira de uma camisa velha (capítulo 6): o machado ficava pendurado nela, e o casaco o cobria.',
        },
      ],
      characterKeys: ['raskolnikov'],
      themeKeys: ['guilt'],
    },
  ],
};

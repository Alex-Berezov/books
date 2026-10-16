import { Language, Prisma, type PrismaClient } from '@prisma/client';

/**
 * Авторы для приёмки страницы автора (`F02-5`, `books-front/e2e/author-page.spec.ts`).
 * Сид идёт только на локальную и e2e-базу, на прод он не попадает, но данные здесь всё равно
 * не выдуманы: даты, премия, экранизации, издатель и ссылки на источники настоящие.
 *
 * - `verne` - полный: все блоки страницы на пяти языках, портрет с подписью, две книги сида;
 *   в данных есть книга и автор, которых на сайте нет (`five-weeks-in-a-balloon`,
 *   `no-such-author`), - страница показывает их текстом без ссылки (`product.md` §1 п.2);
 * - `dumas` - минимальный: имя, слаг и одна книга, ни одного блока и ни одной даты;
 * - `kipling` - «старый», заполненный до F02: биография без разделов, цитаты без `bookSlug`
 *   и вопросы-ответы;
 * - `stevenson` - перевод только на `en`: в «Похожих авторах» Верна на остальных языках
 *   он показывается именем без ссылки (ветка `slug: null` публичной ручки).
 *
 * Слаги и названия книг берутся из каталога `seed.ts` (`SEO_CATALOG_BOOKS`), а не копией:
 * переименование книги там сразу доезжает до ссылок в блоках.
 */

/** Книга каталога сида в той форме, которая нужна здесь. */
export interface CatalogBook {
  slug: string;
  /** Имя автора в каталоге - английское, как в `BookVersion.author`. */
  author: string;
  versions: Array<{ language: Language; title: string; slug: string }>;
}

const LANGS = Object.values(Language);
type ByLang<T> = Record<Language, T>;

const AUTHOR_IDS = {
  verne: 'seed-author-jules-verne',
  dumas: 'seed-author-alexandre-dumas',
  kipling: 'seed-author-rudyard-kipling',
  stevenson: 'seed-author-robert-louis-stevenson',
} as const;
type AuthorKey = keyof typeof AUTHOR_IDS;

/** Переводы авторов. Нет языка - нет перевода (`stevenson`). */
const AUTHOR_TRANSLATIONS: Record<AuthorKey, Partial<ByLang<{ slug: string; name: string }>>> = {
  verne: {
    en: { slug: 'jules-verne', name: 'Jules Verne' },
    ru: { slug: 'zhyul-vern', name: 'Жюль Верн' },
    es: { slug: 'julio-verne', name: 'Julio Verne' },
    fr: { slug: 'jules-verne', name: 'Jules Verne' },
    pt: { slug: 'julio-verne', name: 'Júlio Verne' },
  },
  dumas: {
    en: { slug: 'alexandre-dumas', name: 'Alexandre Dumas' },
    ru: { slug: 'aleksandr-dyuma', name: 'Александр Дюма' },
    es: { slug: 'alejandro-dumas', name: 'Alejandro Dumas' },
    fr: { slug: 'alexandre-dumas', name: 'Alexandre Dumas' },
    pt: { slug: 'alexandre-dumas', name: 'Alexandre Dumas' },
  },
  kipling: {
    en: { slug: 'rudyard-kipling', name: 'Rudyard Kipling' },
    ru: { slug: 'redyard-kipling', name: 'Редьярд Киплинг' },
    es: { slug: 'rudyard-kipling', name: 'Rudyard Kipling' },
    fr: { slug: 'rudyard-kipling', name: 'Rudyard Kipling' },
    pt: { slug: 'rudyard-kipling', name: 'Rudyard Kipling' },
  },
  stevenson: {
    en: { slug: 'robert-louis-stevenson', name: 'Robert Louis Stevenson' },
  },
};

/**
 * Автор книги каталога - по строке `author` самого каталога (она же пишется в
 * `BookVersion.author`), сверенной с английским именем автора здесь. Второго списка
 * «книга -> автор» нет: строка автора и `authorId` у версии не могут разойтись.
 */
function ownerOf(book: CatalogBook): AuthorKey | undefined {
  return (Object.keys(AUTHOR_IDS) as AuthorKey[]).find(
    (key) => AUTHOR_TRANSLATIONS[key].en?.name === book.author,
  );
}

const AUTHOR_FIELDS: Record<
  AuthorKey,
  Pick<Prisma.AuthorUncheckedCreateInput, 'birthDate' | 'deathDate' | 'nativeName' | 'photoCredit'>
> = {
  verne: {
    birthDate: '1828-02-08',
    deathDate: '1905-03-24',
    nativeName: 'Jules Gabriel Verne',
    photoCredit: {
      author: 'Félix Nadar',
      license: 'Public domain',
      sourceUrl:
        'https://commons.wikimedia.org/wiki/File:F%C3%A9lix_Nadar_1820-1910_portraits_Jules_Verne.jpg',
    },
  },
  // У минимального автора дат нет: с датами показывался бы блок «Коротко».
  dumas: { birthDate: null, deathDate: null, nativeName: null, photoCredit: Prisma.DbNull },
  kipling: {
    birthDate: '1865-12-30',
    deathDate: '1936-01-18',
    nativeName: null,
    photoCredit: Prisma.DbNull,
  },
  stevenson: {
    birthDate: '1850-11-13',
    deathDate: '1894-12-03',
    nativeName: null,
    photoCredit: Prisma.DbNull,
  },
};

const VERNE_PORTRAIT =
  'https://commons.wikimedia.org/wiki/Special:FilePath/F%C3%A9lix_Nadar_1820-1910_portraits_Jules_Verne.jpg';

/** Поля перевода, которые пишет сид, кроме ключей, слага и имени. */
type PageFields = Omit<
  Prisma.AuthorTranslationUncheckedCreateInput,
  'id' | 'authorId' | 'language' | 'slug' | 'name' | 'seoId' | 'updatedAt'
>;

/**
 * Все поля страницы пустыми. Повторный сид поверх базы, где автору уже что-то импортировали,
 * возвращает его к заданному здесь составу: минимальный автор остаётся минимальным.
 */
const EMPTY_PAGE = {
  biography: null,
  wikidataUrl: null,
  wikipediaUrl: null,
  photoUrl: null,
  tagline: null,
  quotes: Prisma.DbNull,
  faq: Prisma.DbNull,
  similarSlugs: Prisma.DbNull,
  facts: Prisma.DbNull,
  notableWorks: Prisma.DbNull,
  startHere: Prisma.DbNull,
  timeline: Prisma.DbNull,
  influences: Prisma.DbNull,
  awards: Prisma.DbNull,
  adaptations: Prisma.DbNull,
  funFacts: Prisma.DbNull,
  sources: Prisma.DbNull,
} satisfies Required<PageFields>;

interface VerneTexts {
  tagline: string;
  facts: {
    birthPlace: string;
    deathPlace: string;
    nationality: string;
    occupations: string[];
    genres: string[];
    languages: string[];
  };
  startReason: [string, string];
  timeline: [string, string, string, string, string];
  /** Название первого романа: на сайте его нет, событие хронологии остаётся текстом. */
  firstNovel: string;
  influencedBy: string;
  influenced: string;
  /** Имя в «Влияниях» со слагом, которого на сайте нет: выводится текстом без ссылки. */
  absentAuthor: string;
  award: string;
  funFacts: [string, string, string];
  sourceTitle: string;
  quote: string;
  quoteSource: string;
  faqQuestion: string;
  faqAnswer: string;
  bio: [string, string, string, string];
  bioHeadings: [string, string, string, string];
  wikipedia: string;
}

const VERNE: ByLang<VerneTexts> = {
  en: {
    tagline: 'French novelist, a founder of science fiction',
    facts: {
      birthPlace: 'Nantes, France',
      deathPlace: 'Amiens, France',
      nationality: 'France',
      occupations: ['novelist', 'playwright'],
      genres: ['adventure novel', 'science fiction'],
      languages: ['French'],
    },
    startReason: [
      'A single journey with a clock ticking: the quickest way into his adventure novels.',
      'His best-known voyage under the sea, read once the first book has set the pace.',
    ],
    timeline: [
      'Born in Nantes.',
      'Five Weeks in a Balloon, his first novel, is published by Pierre-Jules Hetzel.',
      'Twenty Thousand Leagues Under the Sea begins as a serial.',
      'Around the World in Eighty Days is serialized in the newspaper Le Temps.',
      'Dies in Amiens.',
    ],
    firstNovel: 'Five Weeks in a Balloon',
    influencedBy: 'Edgar Allan Poe',
    influenced: 'H. G. Wells',
    absentAuthor: 'Victor Hugo',
    award: 'Legion of Honour',
    funFacts: [
      'He was made a Knight of the Legion of Honour in 1870.',
      'Many of his novels first ran as serials in the Magasin d’éducation et de récréation, the magazine of his publisher Pierre-Jules Hetzel.',
      'His series Voyages extraordinaires grew to more than fifty novels.',
    ],
    sourceTitle: 'Encyclopaedia Britannica: Jules Verne',
    quote: 'Anything one man can imagine, other men can make real.',
    quoteSource: 'attributed to Jules Verne',
    faqQuestion: 'What is Jules Verne best known for?',
    faqAnswer: 'For adventure novels such as Around the World in Eighty Days.',
    bio: [
      'Verne grew up in a port city, where ships and maps were part of daily life.',
      'In Paris he met Pierre-Jules Hetzel, the publisher who printed his novels from then on.',
      'The big voyages of the late 1860s and 1870s made him one of the most translated authors in the world:',
      'Today his books are still read as adventure stories and as early science fiction.',
    ],
    bioHeadings: [
      'A childhood among ships',
      'Paris and the publisher',
      'The voyages that made his name',
      'Why he is read today',
    ],
    wikipedia: 'https://en.wikipedia.org/wiki/Jules_Verne',
  },
  ru: {
    tagline: 'Французский писатель, один из основателей научной фантастики',
    facts: {
      birthPlace: 'Нант, Франция',
      deathPlace: 'Амьен, Франция',
      nationality: 'Франция',
      occupations: ['писатель', 'драматург'],
      genres: ['приключенческий роман', 'научная фантастика'],
      languages: ['французский'],
    },
    startReason: [
      'Одно путешествие с тикающими часами: самый быстрый вход в его приключенческую прозу.',
      'Самое известное плавание под водой — читать, когда первая книга задала темп.',
    ],
    timeline: [
      'Родился в Нанте.',
      'Пьер-Жюль Этцель издаёт его первый роман «Пять недель на воздушном шаре».',
      '«Двадцать тысяч лье под водой» начинают выходить с продолжением.',
      '«Вокруг света за восемьдесят дней» печатается в газете Le Temps.',
      'Умер в Амьене.',
    ],
    firstNovel: 'Пять недель на воздушном шаре',
    influencedBy: 'Эдгар Аллан По',
    influenced: 'Герберт Уэллс',
    absentAuthor: 'Виктор Гюго',
    award: 'Орден Почётного легиона',
    funFacts: [
      'В 1870 году он стал кавалером ордена Почётного легиона.',
      'Многие его романы сначала выходили с продолжением в «Журнале воспитания и развлечения» издателя Пьера-Жюля Этцеля.',
      'Серия «Необыкновенные путешествия» выросла больше чем до пятидесяти романов.',
    ],
    sourceTitle: 'Encyclopaedia Britannica: Жюль Верн',
    quote: 'Всё, что человек способен представить, другие люди смогут воплотить.',
    quoteSource: 'приписывается Жюлю Верну',
    faqQuestion: 'Чем известен Жюль Верн?',
    faqAnswer: 'Приключенческими романами, например «Вокруг света за восемьдесят дней».',
    bio: [
      'Верн вырос в портовом городе, где корабли и карты были частью повседневности.',
      'В Париже он познакомился с Пьером-Жюлем Этцелем — издателем, который с тех пор печатал его романы.',
      'Большие путешествия конца 1860-х и 1870-х сделали его одним из самых переводимых авторов мира:',
      'Сегодня его книги читают и как приключения, и как раннюю научную фантастику.',
    ],
    bioHeadings: [
      'Детство среди кораблей',
      'Париж и издатель',
      'Путешествия, которые принесли имя',
      'Почему его читают сегодня',
    ],
    wikipedia: 'https://ru.wikipedia.org/wiki/Верн,_Жюль',
  },
  es: {
    tagline: 'Novelista francés, uno de los fundadores de la ciencia ficción',
    facts: {
      birthPlace: 'Nantes, Francia',
      deathPlace: 'Amiens, Francia',
      nationality: 'Francia',
      occupations: ['novelista', 'dramaturgo'],
      genres: ['novela de aventuras', 'ciencia ficción'],
      languages: ['francés'],
    },
    startReason: [
      'Un solo viaje con el reloj en contra: la entrada más rápida a sus novelas de aventuras.',
      'Su viaje submarino más conocido, para leer cuando el primer libro ya marcó el ritmo.',
    ],
    timeline: [
      'Nace en Nantes.',
      'Pierre-Jules Hetzel publica su primera novela, Cinco semanas en globo.',
      'Veinte mil leguas de viaje submarino empieza a publicarse por entregas.',
      'La vuelta al mundo en ochenta días se publica por entregas en el diario Le Temps.',
      'Muere en Amiens.',
    ],
    firstNovel: 'Cinco semanas en globo',
    influencedBy: 'Edgar Allan Poe',
    influenced: 'H. G. Wells',
    absentAuthor: 'Victor Hugo',
    award: 'Legión de Honor',
    funFacts: [
      'En 1870 fue nombrado caballero de la Legión de Honor.',
      'Muchas de sus novelas aparecieron primero por entregas en el Magasin d’éducation et de récréation, la revista de su editor Pierre-Jules Hetzel.',
      'Su serie Viajes extraordinarios llegó a más de cincuenta novelas.',
    ],
    sourceTitle: 'Encyclopaedia Britannica: Julio Verne',
    quote: 'Todo lo que un hombre pueda imaginar, otros podrán hacerlo realidad.',
    quoteSource: 'atribuida a Julio Verne',
    faqQuestion: '¿Por qué es conocido Julio Verne?',
    faqAnswer: 'Por novelas de aventuras como La vuelta al mundo en ochenta días.',
    bio: [
      'Verne creció en una ciudad portuaria, donde barcos y mapas eran parte de la vida diaria.',
      'En París conoció a Pierre-Jules Hetzel, el editor que desde entonces imprimió sus novelas.',
      'Los grandes viajes de finales de la década de 1860 y de la de 1870 lo hicieron uno de los autores más traducidos:',
      'Hoy sus libros se leen como aventuras y como ciencia ficción temprana.',
    ],
    bioHeadings: [
      'Una infancia entre barcos',
      'París y el editor',
      'Los viajes que le dieron nombre',
      'Por qué se lee hoy',
    ],
    wikipedia: 'https://es.wikipedia.org/wiki/Julio_Verne',
  },
  fr: {
    tagline: 'Romancier français, l’un des fondateurs de la science-fiction',
    facts: {
      birthPlace: 'Nantes, France',
      deathPlace: 'Amiens, France',
      nationality: 'France',
      occupations: ['romancier', 'dramaturge'],
      genres: ['roman d’aventures', 'science-fiction'],
      languages: ['français'],
    },
    startReason: [
      'Un seul voyage, montre en main : l’entrée la plus rapide dans ses romans d’aventures.',
      'Son voyage sous-marin le plus connu, à lire quand le premier livre a donné le rythme.',
    ],
    timeline: [
      'Naît à Nantes.',
      'Pierre-Jules Hetzel publie son premier roman, Cinq semaines en ballon.',
      'Vingt mille lieues sous les mers commence à paraître en feuilleton.',
      'Le Tour du monde en quatre-vingts jours paraît en feuilleton dans le journal Le Temps.',
      'Meurt à Amiens.',
    ],
    firstNovel: 'Cinq semaines en ballon',
    influencedBy: 'Edgar Allan Poe',
    influenced: 'H. G. Wells',
    absentAuthor: 'Victor Hugo',
    award: 'Légion d’honneur',
    funFacts: [
      'Il est fait chevalier de la Légion d’honneur en 1870.',
      'Beaucoup de ses romans paraissent d’abord en feuilleton dans le Magasin d’éducation et de récréation, la revue de son éditeur Pierre-Jules Hetzel.',
      'Sa série des Voyages extraordinaires compte plus de cinquante romans.',
    ],
    sourceTitle: 'Encyclopaedia Britannica : Jules Verne',
    quote: 'Tout ce qu’un homme est capable d’imaginer, d’autres hommes pourront le réaliser.',
    quoteSource: 'attribuée à Jules Verne',
    faqQuestion: 'Pourquoi Jules Verne est-il connu ?',
    faqAnswer: 'Pour ses romans d’aventures, comme Le Tour du monde en quatre-vingts jours.',
    bio: [
      'Verne grandit dans une ville portuaire, où bateaux et cartes font partie du quotidien.',
      'À Paris, il rencontre Pierre-Jules Hetzel, l’éditeur qui imprimera désormais ses romans.',
      'Les grands voyages de la fin des années 1860 et des années 1870 font de lui l’un des auteurs les plus traduits :',
      'Aujourd’hui, ses livres se lisent comme des aventures et comme une science-fiction des débuts.',
    ],
    bioHeadings: [
      'Une enfance parmi les navires',
      'Paris et l’éditeur',
      'Les voyages qui ont fait son nom',
      'Pourquoi on le lit aujourd’hui',
    ],
    wikipedia: 'https://fr.wikipedia.org/wiki/Jules_Verne',
  },
  pt: {
    tagline: 'Romancista francês, um dos fundadores da ficção científica',
    facts: {
      birthPlace: 'Nantes, França',
      deathPlace: 'Amiens, França',
      nationality: 'França',
      occupations: ['romancista', 'dramaturgo'],
      genres: ['romance de aventuras', 'ficção científica'],
      languages: ['francês'],
    },
    startReason: [
      'Uma única viagem contra o relógio: a entrada mais rápida em seus romances de aventuras.',
      'Sua viagem submarina mais conhecida, para ler depois que o primeiro livro marcou o ritmo.',
    ],
    timeline: [
      'Nasce em Nantes.',
      'Pierre-Jules Hetzel publica seu primeiro romance, Cinco semanas em um balão.',
      'Vinte mil léguas submarinas começa a sair em folhetim.',
      'A volta ao mundo em oitenta dias sai em folhetim no jornal Le Temps.',
      'Morre em Amiens.',
    ],
    firstNovel: 'Cinco semanas em um balão',
    influencedBy: 'Edgar Allan Poe',
    influenced: 'H. G. Wells',
    absentAuthor: 'Victor Hugo',
    award: 'Legião de Honra',
    funFacts: [
      'Em 1870 foi nomeado cavaleiro da Legião de Honra.',
      'Muitos de seus romances saíram primeiro em folhetim no Magasin d’éducation et de récréation, a revista de seu editor Pierre-Jules Hetzel.',
      'Sua série Viagens extraordinárias passou de cinquenta romances.',
    ],
    sourceTitle: 'Encyclopaedia Britannica: Júlio Verne',
    quote: 'Tudo o que um homem pode imaginar, outros homens poderão tornar realidade.',
    quoteSource: 'atribuída a Júlio Verne',
    faqQuestion: 'Pelo que Júlio Verne é conhecido?',
    faqAnswer: 'Por romances de aventuras como A volta ao mundo em oitenta dias.',
    bio: [
      'Verne cresceu numa cidade portuária, onde navios e mapas faziam parte do dia a dia.',
      'Em Paris conheceu Pierre-Jules Hetzel, o editor que a partir de então imprimiu seus romances.',
      'As grandes viagens do fim da década de 1860 e da de 1870 o tornaram um dos autores mais traduzidos:',
      'Hoje seus livros são lidos como aventuras e como ficção científica pioneira.',
    ],
    bioHeadings: [
      'Uma infância entre navios',
      'Paris e o editor',
      'As viagens que o tornaram conhecido',
      'Por que é lido hoje',
    ],
    wikipedia: 'https://pt.wikipedia.org/wiki/Júlio_Verne',
  },
};

const BRITANNICA = 'https://www.britannica.com/biography/Jules-Verne';
const WIKIDATA = 'https://www.wikidata.org/wiki/Q33977';

/** Слаг и название книги каталога на языке. Нет книги или языка - сид падает, а не молчит. */
function catalogBook(catalog: CatalogBook[], bookSlug: string, lang: Language) {
  const version = catalog
    .find((book) => book.slug === bookSlug)
    ?.versions.find((v) => v.language === lang);
  if (!version) {
    throw new Error(`seed-authors: в каталоге seed.ts нет книги ${bookSlug} на языке ${lang}`);
  }
  return { slug: version.slug, title: version.title };
}

function translationOf(key: AuthorKey, lang: Language): { slug: string; name: string } {
  const translation = AUTHOR_TRANSLATIONS[key][lang];
  if (!translation) throw new Error(`seed-authors: у автора ${key} нет перевода на ${lang}`);
  return translation;
}

function vernePage(catalog: CatalogBook[], lang: Language): PageFields {
  const t = VERNE[lang];
  const around = catalogBook(catalog, 'around-the-world-in-eighty-days', lang);
  const leagues = catalogBook(catalog, 'twenty-thousand-leagues-under-the-sea', lang);
  const link = (book: { slug: string; title: string }) =>
    `<a href="/${lang}/book/${book.slug}">${book.title}</a>`;

  const biography =
    `<h3>${t.bioHeadings[0]}</h3><p>${t.bio[0]}</p>` +
    `<h3>${t.bioHeadings[1]}</h3><p>${t.bio[1]}</p>` +
    `<h3>${t.bioHeadings[2]}</h3><p>${t.bio[2]} ${link(leagues)}, ${link(around)}.</p>` +
    `<h3>${t.bioHeadings[3]}</h3><p>${t.bio[3]}</p>`;

  return {
    biography,
    wikidataUrl: WIKIDATA,
    wikipediaUrl: t.wikipedia,
    photoUrl: VERNE_PORTRAIT,
    tagline: t.tagline,
    facts: {
      gender: 'male',
      birthPlace: t.facts.birthPlace,
      deathPlace: t.facts.deathPlace,
      nationality: t.facts.nationality,
      occupations: t.facts.occupations,
      movements: [],
      genres: t.facts.genres,
      languages: t.facts.languages,
      pseudonyms: [],
    },
    notableWorks: [
      { title: t.firstNovel, year: 1863, bookSlug: null },
      { title: leagues.title, year: 1870, bookSlug: leagues.slug },
      { title: around.title, year: 1873, bookSlug: around.slug },
    ],
    startHere: [
      { bookSlug: around.slug, reason: t.startReason[0] },
      { bookSlug: leagues.slug, reason: t.startReason[1] },
    ],
    timeline: [
      { year: 1828, text: t.timeline[0], bookSlug: null },
      // Книги нет на сайте: событие показывается без ссылки.
      { year: 1863, text: t.timeline[1], bookSlug: 'five-weeks-in-a-balloon' },
      { year: 1869, text: t.timeline[2], bookSlug: leagues.slug },
      { year: 1872, text: t.timeline[3], bookSlug: around.slug },
      { year: 1905, text: t.timeline[4], bookSlug: null },
    ],
    influences: {
      influencedBy: [
        { name: t.influencedBy, authorSlug: null },
        { name: translationOf('dumas', lang).name, authorSlug: translationOf('dumas', lang).slug },
        // Слаг, которого нет в базе: имя остаётся текстом без ссылки.
        { name: t.absentAuthor, authorSlug: 'no-such-author' },
      ],
      influenced: [{ name: t.influenced, authorSlug: null }],
    },
    awards: [{ name: t.award, year: 1870, nomination: false }],
    adaptations: [
      {
        title: around.title,
        year: 1956,
        kind: 'film',
        basedOn: around.title,
        bookSlug: around.slug,
      },
      {
        title: leagues.title,
        year: 1954,
        kind: 'film',
        basedOn: leagues.title,
        bookSlug: leagues.slug,
      },
    ],
    funFacts: t.funFacts.map((text) => ({
      text,
      sourceTitle: t.sourceTitle,
      sourceUrl: BRITANNICA,
    })),
    quotes: [{ text: t.quote, source: t.quoteSource, bookSlug: null }],
    faq: [{ question: t.faqQuestion, answer: t.faqAnswer }],
    // Дюма и Киплинг - ссылки; Стивенсон - ссылка только на `en`, на остальных языках имя
    // без ссылки (перевода нет); `no-such-author` в базе нет и пропускается (решение арбитра
    // 16.10.2026, `F02 | F02-4`, Р8).
    similarSlugs: [
      translationOf('dumas', lang).slug,
      translationOf('kipling', lang).slug,
      translationOf('stevenson', Language.en).slug,
      'no-such-author',
    ],
    sources: [
      { title: t.sourceTitle, url: BRITANNICA },
      { title: `Wikidata: ${translationOf('verne', lang).name}`, url: WIKIDATA },
    ],
  };
}

/** «Старый» автор: только поля, которые были до F02, и цитаты в старой форме - без `bookSlug`. */
const KIPLING_LEGACY: ByLang<{ bio: string; quote: string; source: string; q: string; a: string }> =
  {
    en: {
      bio: '<p>Rudyard Kipling was born in Bombay and spent his childhood between India and England.</p><p>The Jungle Book grew out of the stories he wrote while living in Vermont.</p>',
      quote: 'The strength of the Pack is the Wolf, and the strength of the Wolf is the Pack.',
      source: 'The Second Jungle Book',
      q: 'What is Rudyard Kipling best known for?',
      a: 'For The Jungle Book.',
    },
    ru: {
      bio: '<p>Редьярд Киплинг родился в Бомбее, детство провёл между Индией и Англией.</p><p>«Книга джунглей» выросла из рассказов, написанных в Вермонте.</p>',
      quote: 'Сила Стаи — в Волке, и сила Волка — в Стае.',
      source: 'Вторая книга джунглей',
      q: 'Чем известен Редьярд Киплинг?',
      a: '«Книгой джунглей».',
    },
    es: {
      bio: '<p>Rudyard Kipling nació en Bombay y pasó su infancia entre la India e Inglaterra.</p><p>El libro de la selva nació de los cuentos que escribió en Vermont.</p>',
      quote: 'La fuerza de la Manada es el Lobo, y la fuerza del Lobo es la Manada.',
      source: 'El segundo libro de la selva',
      q: '¿Por qué es conocido Rudyard Kipling?',
      a: 'Por El libro de la selva.',
    },
    fr: {
      bio: '<p>Rudyard Kipling naît à Bombay et passe son enfance entre l’Inde et l’Angleterre.</p><p>Le Livre de la jungle naît des récits écrits dans le Vermont.</p>',
      quote: 'La force de la Meute, c’est le Loup, et la force du Loup, c’est la Meute.',
      source: 'Le Second Livre de la jungle',
      q: 'Pourquoi Rudyard Kipling est-il connu ?',
      a: 'Pour Le Livre de la jungle.',
    },
    pt: {
      bio: '<p>Rudyard Kipling nasceu em Bombaim e passou a infância entre a Índia e a Inglaterra.</p><p>O livro da selva nasceu dos contos escritos em Vermont.</p>',
      quote: 'A força da Alcateia é o Lobo, e a força do Lobo é a Alcateia.',
      source: 'O segundo livro da selva',
      q: 'Pelo que Rudyard Kipling é conhecido?',
      a: 'Por O livro da selva.',
    },
  };

function pageFor(catalog: CatalogBook[], key: AuthorKey, lang: Language): PageFields {
  if (key === 'verne') return vernePage(catalog, lang);
  if (key === 'kipling') {
    const k = KIPLING_LEGACY[lang];
    return {
      biography: k.bio,
      quotes: [{ text: k.quote, source: k.source }],
      faq: [{ question: k.q, answer: k.a }],
    };
  }
  return {};
}

/**
 * Заводит авторов приёмки и привязывает к ним все версии их книг каталога.
 * Идемпотентно: автор по фиксированному id, перевод по `(authorId, language)` с полным
 * набором полей страницы (`EMPTY_PAGE`), привязка - обновлением `authorId` у версий книги.
 */
export async function seedPageAuthors(prisma: PrismaClient, catalog: CatalogBook[]): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      for (const key of Object.keys(AUTHOR_IDS) as AuthorKey[]) {
        const id = AUTHOR_IDS[key];
        await tx.author.upsert({
          where: { id },
          update: AUTHOR_FIELDS[key],
          create: { id, ...AUTHOR_FIELDS[key] },
          select: { id: true },
        });

        for (const lang of LANGS) {
          const translation = AUTHOR_TRANSLATIONS[key][lang];
          if (!translation) continue;
          const data = { ...EMPTY_PAGE, ...pageFor(catalog, key, lang), ...translation };
          await tx.authorTranslation.upsert({
            where: { authorId_language: { authorId: id, language: lang } },
            update: data,
            create: { ...data, authorId: id, language: lang },
            select: { id: true },
          });
        }
      }

      const withBooks = new Set<AuthorKey>();
      for (const catalogEntry of catalog) {
        const owner = ownerOf(catalogEntry);
        if (!owner) continue;
        const book = await tx.book.findUnique({
          where: { slug: catalogEntry.slug },
          select: { id: true },
        });
        if (!book) {
          throw new Error(
            `seed-authors: книги ${catalogEntry.slug} нет, каталог заводится в seed.ts выше`,
          );
        }
        await tx.bookVersion.updateMany({
          where: { bookId: book.id },
          data: { authorId: AUTHOR_IDS[owner] },
        });
        withBooks.add(owner);
      }
      // Автор приёмки без единой книги каталога - сид устарел: страница отдала бы 0 книг.
      const orphans = (Object.keys(AUTHOR_IDS) as AuthorKey[]).filter((k) => !withBooks.has(k));
      if (orphans.length > 0) {
        throw new Error(`seed-authors: у авторов ${orphans.join(', ')} нет книги в каталоге`);
      }
    },
    { timeout: 30_000, maxWait: 15_000 },
  );
}

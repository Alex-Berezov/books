import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Language } from '@prisma/client';
import { readSlugRedirect, taxonomyFixture, uniqueMark } from './helpers/taxonomy-null-cases';

/**
 * `LEGACY-390` и `LEGACY-392`. Второй путь смерти публичного адреса категории:
 * `DELETE /categories/:id` сносит переводы по всем языкам разом. До 15.09.2026
 * политика владельца («уводить на родителя, а не в 404») жила только в первом
 * пути — удалении одного перевода.
 *
 * С 22.09.2026 здесь же живут кейсы `LEGACY-392`: у категории умирает не один вид
 * адреса, а два. Кроме слагов переводов умирает **базовый** `Category.slug`,
 * и 308 с него идёт на перевод прямого родителя того же языка — одним переходом.
 *
 * 🔴 Что сажает именно этот набор, а не юниты рядом. В спеке сервиса слой данных
 * замокан целиком: она доказывает, что ветка выбрана и запрос имеет нужную форму,
 * но подтвердит любую форму, которую в мок заложили. Здесь работает настоящая
 * транзакция на настоящей базе — и проверяется, что после `DELETE /categories/:id`
 * в истории слагов действительно лежит строка на перевод родителя, что цепочка
 * прежних слагов уезжает на него же, а условие «слаг занят чужой живой категорией»
 * отбирает по правде, а не по моку.
 *
 * ⚠️ Кейс про собственный базовый слаг **на живой базе зелёный при обеих формах
 * условия**: отбор идёт после `category.delete`, поэтому своя строка не нашлась бы
 * и без явного `id: { not: id }`. Форму условия сажает юнит
 * (`category.service.spec.ts`, «собственный базовый слаг из проверки исключён»);
 * здесь тот же случай закреплён по результату — 308 обязан быть выдан.
 *
 * Форма — решения арбитра 15.09.2026 (`decisions-log.md`).
 */

type TokenBody = { accessToken: string };

describe('LEGACY-390, LEGACY-392: удаление категории целиком и история слагов (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;
  const categories = taxonomyFixture(http, () => admin, 'categories', { type: 'genre' });

  /** Категория с ru-переводом. Базовый слаг задаётся отдельно от слага перевода. */
  const withRuTranslation = async (
    baseSlug: string,
    ruSlug: string,
    parentId?: string,
  ): Promise<string> => {
    const id = await categories.create(baseSlug, { slug: baseSlug, key: baseSlug, parentId });
    await categories.addTranslation(id, Language.ru, ruSlug);
    return id;
  };

  const redirectsTo = (oldSlug: string): Promise<string | null> =>
    readSlugRedirect(prisma, 'category', Language.ru, oldSlug);

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const email = 'admin@example.com';
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) {
      admin = (reg.body as TokenBody).accessToken;
    } else {
      const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
      admin = (login.body as TokenBody).accessToken;
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('обычный случай: адрес удалённой категории ведёт на перевод родителя', async () => {
    const parentRu = uniqueMark('l390-roditel');
    const parentId = await withRuTranslation(uniqueMark('l390-parent'), parentRu);

    const childRu = uniqueMark('l390-rebenok');
    const childId = await withRuTranslation(uniqueMark('l390-child'), childRu, parentId);

    await categories.drop(childId);

    expect(await redirectsTo(childRu)).toBe(parentRu);
  });

  /**
   * 🔴 Цепочка. Слаг переименовали до удаления, поэтому в истории уже лежит
   * `roman-old → roman`. `SlugRedirectService.record` умеет переписывать такие строки
   * на нового преемника — но только если он вызван ДО уборки. При обратном порядке
   * `roman-old` отвечал бы 404 при живом родителе, а выданный когда-то 308
   * из поискового индекса не отзывается (находка ревью 15.09.2026).
   */
  it('цепочка прежних слагов уезжает на родителя, а не теряется', async () => {
    const parentRu = uniqueMark('l390-p4-ru');
    const parentId = await withRuTranslation(uniqueMark('l390-p4'), parentRu);

    const firstRu = uniqueMark('l390-c4-staryj');
    const childId = await withRuTranslation(uniqueMark('l390-c4'), firstRu, parentId);

    const secondRu = uniqueMark('l390-c4-novyj');
    await categories.renameTranslation(childId, Language.ru, secondRu);
    expect(await redirectsTo(firstRu)).toBe(secondRu);

    await categories.drop(childId);

    expect(await redirectsTo(secondRu)).toBe(parentRu);
    expect(await redirectsTo(firstRu)).toBe(parentRu);
  });

  /**
   * Отличие от `deleteTranslation` по результату. Базовый слаг совпал со слагом
   * перевода — именно так заводит термины сид. В соседнем пути такой адрес переживает
   * удаление (категория остаётся жить) и записи не получает; здесь категория исчезает
   * вся, фоллбэк публичного резолва по базовому слагу не сработает, адрес мёртв —
   * значит 308 обязан быть выдан.
   */
  it('собственный базовый слаг не мешает: адрес умер вместе с категорией', async () => {
    const parentRu = uniqueMark('l390-p2-ru');
    const parentId = await withRuTranslation(uniqueMark('l390-p2'), parentRu);

    const sameSlug = uniqueMark('l390-same');
    const childId = await withRuTranslation(sameSlug, sameSlug, parentId);

    await categories.drop(childId);

    expect(await redirectsTo(sameSlug)).toBe(parentRu);
  });

  /**
   * Обратная половина того же условия: слаг занят базовым `Category.slug` **чужой**
   * категории, которая остаётся жить. Публичный резолв продолжит отвечать по ней
   * 200, фронт уйдёт в 404 мимо истории слагов, и 308 не выдастся никогда — запись
   * была бы строкой, которой ничто не соответствует.
   */
  it('слаг, занятый базовым слагом чужой живой категории, записи не получает', async () => {
    const parentId = await withRuTranslation(uniqueMark('l390-p3'), uniqueMark('l390-p3-ru'));

    const occupied = uniqueMark('l390-occupied');
    await categories.create(occupied, { slug: occupied, key: occupied });

    const childId = await withRuTranslation(uniqueMark('l390-c3'), occupied, parentId);

    await categories.drop(childId);

    expect(await redirectsTo(occupied)).toBeNull();
  });

  /**
   * 🔴 Обратная сторона той же ветки, и она про уже выданные 308. Адрес пережил
   * удаление — его держит базовый `Category.slug` чужой живой категории, — значит
   * записи, которые вели на него, ведут на работающую страницу. Снести их значило бы
   * выдать 404 по индексированному адресу, а он из индекса не отзывается (решение
   * арбитра 15.09.2026).
   */
  it('при живом чужом базовом слаге прежний адрес сохраняет свой 308', async () => {
    const parentId = await withRuTranslation(uniqueMark('l390-p5'), uniqueMark('l390-p5-ru'));

    // Чужая живая категория держит слаг базовым — адрес по нему отвечает и после
    // удаления нашего термина.
    const occupied = uniqueMark('l390-zanjat');
    await categories.create(occupied, { slug: occupied, key: occupied });

    // У удаляемой категории ru-слаг сперва другой, потом переименован в занятый:
    // так в истории заводится строка `staryj → occupied`.
    const staryj = uniqueMark('l390-c5-staryj');
    const childId = await withRuTranslation(uniqueMark('l390-c5'), staryj, parentId);
    await categories.renameTranslation(childId, Language.ru, occupied);
    expect(await redirectsTo(staryj)).toBe(occupied);

    await categories.drop(childId);

    // Строка обязана уцелеть: её цель по-прежнему отвечает 200.
    expect(await redirectsTo(staryj)).toBe(occupied);
  });

  /**
   * 🔴 `LEGACY-394` на настоящей базе. Дефект, внесённый правкой `LEGACY-390`
   * и уехавший на прод в `v1.0.77`: живость адреса спрашивалась без отбора
   * по языку, и один чужой перевод объявлял слаг живым сразу во всех пяти.
   *
   * Почему кейс нужен здесь, а не только юнитом: юнит сажает форму запроса,
   * а мок отвечает по форме вызова, а не по значениям — то есть подтвердит любую
   * выборку, которую в него заложили. Здесь `categoryTranslation.findMany`
   * отбирает по правде, и проверяется результат: какие строки истории остались,
   * а какие снялись. Тем самым путём дефект в прод и уехал.
   *
   * Сценарий. Базовый слаг умирающей категории переименован, поэтому в истории
   * лежат строки `staryj → zanjat` **на все пять языков** (их пишет
   * `recordBaseSlugChange`). Тот же `zanjat` носит **en**-перевод другой, живой
   * категории. Значит `/en/categories/zanjat` отвечает 200, а `/ru/categories/zanjat`
   * после удаления — 404: строка `staryj → zanjat` обязана уцелеть в `en`
   * и сняться в `ru`.
   */
  it('LEGACY-394: чужой перевод держит адрес только в своём языке', async () => {
    // Чужая живая категория: базовый слаг у неё свой, а вот en-перевод занимает
    // тот слаг, на который умирающая категория переименуется ниже.
    const zanjat = uniqueMark('l394-zanjat');
    const otherId = await categories.create(uniqueMark('l394-other'), {
      slug: uniqueMark('l394-other-base'),
      key: uniqueMark('l394-other-key'),
    });
    await categories.addTranslation(otherId, Language.en, zanjat);

    // Умирающая категория: переводов нет вовсе, работает только уборка базового слага.
    const staryj = uniqueMark('l394-staryj');
    const dyingId = await categories.create(staryj, { slug: staryj, key: staryj });
    await categories.renameBase(dyingId, zanjat);

    // История заведена на оба языка сразу — это и есть то, что уборка обязана
    // разобрать по языкам, а не одним махом.
    expect(await redirectsTo(staryj)).toBe(zanjat);
    expect(await readSlugRedirect(prisma, 'category', Language.en, staryj)).toBe(zanjat);

    await categories.drop(dyingId);

    // `ru`: адрес мёртв — чужой en-перевод его здесь не оживляет, строка снята.
    expect(await redirectsTo(staryj)).toBeNull();
    // `en`: адрес жив чужим переводом — 308 ведёт на работающую страницу и уцелел.
    expect(await readSlugRedirect(prisma, 'category', Language.en, staryj)).toBe(zanjat);
  });

  /**
   * 🔴 `LEGACY-392` на настоящей базе. Базовый `Category.slug` — публичный адрес
   * во **всех** пяти языках: резолв ищет пару `language_slug`, а при промахе падает
   * на `Category.slug`. До этой правки удаление категории уносило его в 404 при живом
   * родителе: 308 писались только со слагов переводов, а с базового — ни одного.
   *
   * Почему кейс нужен здесь, а не только юнитом: юнит доказывает, что вызов сделан
   * с нужными аргументами, но `SlugRedirectService` в нём замокан целиком — строки
   * в базе он не пишет и переписывание цепочек не выполняет. Здесь работает
   * настоящий сервис на настоящей транзакции, и проверяется результат: что лежит
   * в истории слагов после `DELETE /categories/:id`.
   *
   * 🔴 Форма — один переход (решение арбитра 22.09.2026). Поэтому проверяется
   * не «редирект есть», а его адресат: он обязан быть **переводом** родителя
   * (`parentRu`), а не его базовым слагом (`parentBase`). Второй вариант отправил бы
   * посетителя на адрес, который сам отвечает редиректом, — два перехода вместо
   * одного, а там, где перевода у родителя нет, ещё и 308 в 404.
   */
  it('LEGACY-392: базовый слаг удалённой категории уводит на перевод родителя', async () => {
    const parentBase = uniqueMark('l392-p-base');
    const parentRu = uniqueMark('l392-p-ru');
    const parentId = await withRuTranslation(parentBase, parentRu);

    // Базовый слаг ребёнка нарочно отличается от слага его ru-перевода: иначе оба
    // адреса совпали бы, и кейс не отличал бы новый 308 от уже работавшего.
    const childBase = uniqueMark('l392-c-base');
    const childRu = uniqueMark('l392-c-ru');
    const childId = await withRuTranslation(childBase, childRu, parentId);

    await categories.drop(childId);

    // Новый 308: адрес, который раньше жил только фоллбэком на базовый слаг.
    // 🔴 Проверка точным значением и есть проверка формы: `parentRu` — перевод
    // родителя, а `parentBase` — его базовый слаг, и вариант в два перехода
    // записал бы сюда второе. Отдельного `not.toBe(parentBase)` рядом не ставится:
    // упасть он не смог бы никогда — строка выше упала бы первой (находка ревью
    // 22.09.2026 о проверке, которая не умеет краснеть).
    expect(await redirectsTo(childBase)).toBe(parentRu);
    // Прежнее поведение на слаге перевода не тронуто.
    expect(await redirectsTo(childRu)).toBe(parentRu);
  });

  /**
   * Вторая половина D1 для базового слага: за родителя адресата не достраивают.
   * У родителя из кейса выше есть только ru-перевод, значит в `en` базовый слаг
   * ребёнка остаётся 404 — невыданный 308 чинится вторым заходом, выданный
   * из поискового индекса не отзывается.
   */
  it('LEGACY-392: в языке без перевода у родителя базовый слаг остаётся 404', async () => {
    const parentRu = uniqueMark('l392-p2-ru');
    const parentId = await withRuTranslation(uniqueMark('l392-p2-base'), parentRu);

    const childBase = uniqueMark('l392-c2-base');
    const childId = await withRuTranslation(childBase, uniqueMark('l392-c2-ru'), parentId);

    await categories.drop(childId);

    // `ru` — преемник есть, и он назван точно: `not.toBeNull()` прошёл бы и на чужой
    // строке, попавшей сюда переписыванием цепочек.
    expect(await redirectsTo(childBase)).toBe(parentRu);
    // `en` — перевода у родителя нет, и строки быть не должно.
    expect(await readSlugRedirect(prisma, 'category', Language.en, childBase)).toBeNull();
  });

  /**
   * 🔴 Цепочка на **базовом** слаге, на настоящей базе. Соседний кейс про цепочку
   * работает на слагах переводов, а единственный базовый живёт в `LEGACY-394`, где
   * цепочка нарочно НЕ переписывается. То есть половина `record` — переписывание
   * цепочек (`updateMany` по `newSlug = oldSlug`) — для базового слага живой базой
   * не проверена нигде, а юнит на порядок работает на моках и настоящих строк
   * не двигает.
   *
   * Сценарий. Базовый слаг переименован до удаления, поэтому `recordBaseSlugChange`
   * завёл `staryj → novyj` сразу на пять языков. Категорию удаляют при живом
   * родителе: `novyj` обязан уехать на перевод родителя, и `staryj` — вместе с ним,
   * одним переходом, а не остаться 308-м на адрес, который уже отвечает 404.
   *
   * Кейс краснеет от перестановки нового цикла после уборки: тогда `deleteMany`
   * по `newSlug: novyj` снесёт строку `staryj` раньше, чем `record` успеет её
   * подобрать, и вместо 308 по индексированному адресу выдастся 404.
   */
  it('LEGACY-392: цепочка прежних базовых слагов уезжает на родителя, а не теряется', async () => {
    const parentRu = uniqueMark('l392-p3-ru');
    const parentId = await withRuTranslation(uniqueMark('l392-p3-base'), parentRu);

    const staryj = uniqueMark('l392-c3-staryj');
    const childId = await withRuTranslation(staryj, uniqueMark('l392-c3-ru'), parentId);

    const novyj = uniqueMark('l392-c3-novyj');
    await categories.renameBase(childId, novyj);
    expect(await redirectsTo(staryj)).toBe(novyj);

    await categories.drop(childId);

    // Новый базовый слаг уехал на родителя...
    expect(await redirectsTo(novyj)).toBe(parentRu);
    // ...и прежний вместе с ним, одним переходом, а не цепочкой в мёртвый адрес.
    expect(await redirectsTo(staryj)).toBe(parentRu);
  });
  /**
   * 🔴 Сужение множества языков на живой базе (решение арбитра 22.09.2026
   * по находке ревью). Базовый слаг был адресом **только там, где у категории был
   * перевод**: без перевода резолв отдаёт 200 с `translation: null`, а фронт уходит
   * в `isUnaddressableInLanguage → notFound()` **до** истории слагов — то есть
   * адрес отвечал 404 и до удаления. 308 на таком языке был бы не возвратом
   * умершего адреса, а заведением нового, а он из индекса не отзывается.
   *
   * Стенд разводит два условия, которые легко спутать: у родителя перевод на `en`
   * **есть**, а у самой категории его **нет**. Преемник, стало быть, доступен —
   * и всё равно строки быть не должно.
   *
   * Кейс краснеет от возврата дефекта: верни цикл на все мёртвые языки — и `en`
   * получит 308 с адреса, который никогда не открывался.
   */
  it('LEGACY-392: язык без перевода у категории 308 не получает, даже когда преемник есть', async () => {
    const parentRu = uniqueMark('l392-p4-ru');
    const parentId = await withRuTranslation(uniqueMark('l392-p4-base'), parentRu);
    // У родителя есть и en-перевод — преемник в `en` доступен.
    const parentEn = uniqueMark('l392-p4-en');
    await categories.addTranslation(parentId, Language.en, parentEn);

    // У категории перевод только на `ru`: в `en` её базовый слаг адресом не был.
    const childBase = uniqueMark('l392-c4-base');
    const childId = await withRuTranslation(childBase, uniqueMark('l392-c4-ru'), parentId);

    await categories.drop(childId);

    // `ru` — адрес был живым, 308 выдан.
    expect(await redirectsTo(childBase)).toBe(parentRu);
    // 🔴 `en` — преемник есть, а адреса не было: строки быть не должно.
    expect(await readSlugRedirect(prisma, 'category', Language.en, childBase)).toBeNull();
  });
  /**
   * 🔴 Та же проверка живости по языку, но на настоящей базе (находка ревью
   * 22.09.2026). Юнит рядом сажает условие по форме вызова; здесь отбор идёт
   * по правде, и проверяется результат — какие строки легли в историю.
   *
   * Стенд: у удаляемой категории переводы на `ru` и `en`, базовый слаг `fiction`.
   * Чужая живая категория держит **en-перевод** с тем же слагом `fiction` —
   * `@@unique([language, slug])` это разрешает. Значит `/en/category/fiction`
   * отвечает 200 чужой страницей и после удаления, а `/ru/category/fiction` — 404.
   * 308 обязан быть выдан только в `ru`.
   */
  it('LEGACY-392: язык, где базовый слаг жив чужим переводом, 308 не получает', async () => {
    const parentRu = uniqueMark('l392-p5-ru');
    const parentId = await withRuTranslation(uniqueMark('l392-p5-base'), parentRu);
    const parentEn = uniqueMark('l392-p5-en');
    await categories.addTranslation(parentId, Language.en, parentEn);

    // Чужая живая категория занимает базовый слаг удаляемой — но только в `en`.
    const childBase = uniqueMark('l392-c5-base');
    const otherId = await categories.create(uniqueMark('l392-other'), {
      slug: uniqueMark('l392-other-base'),
      key: uniqueMark('l392-other-key'),
    });
    await categories.addTranslation(otherId, Language.en, childBase);

    const childId = await withRuTranslation(childBase, uniqueMark('l392-c5-ru'), parentId);
    await categories.addTranslation(childId, Language.en, uniqueMark('l392-c5-en'));

    await categories.drop(childId);

    // `ru` — адрес умер, 308 выдан.
    expect(await redirectsTo(childBase)).toBe(parentRu);
    // 🔴 `en` — адрес жив чужим переводом: 308 увёл бы посетителя с работающей
    // страницы, поэтому строки быть не должно.
    expect(await readSlugRedirect(prisma, 'category', Language.en, childBase)).toBeNull();
  });
});

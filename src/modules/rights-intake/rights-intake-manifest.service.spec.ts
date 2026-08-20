import { RightsIntakeManifestService } from './rights-intake-manifest.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RIGHTS_AGENT_MANIFEST_VERSION } from './rights-intake.constants';
import { RightsFileStorageService } from '../../shared/rights-file-storage/rights-file-storage.service';

interface PrismaStub {
  rightsIntake: {
    findUnique: jest.Mock;
    update: jest.Mock;
  };
}

const createPrismaStub = (): PrismaStub => ({
  rightsIntake: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
});

/**
 * WP-9.1: манифест сохраняется в приватное хранилище прав, потому что повторный GET даёт
 * другие байты. Заглушка возвращает готовый дескриптор — сюда же смотрит тест, проверяющий,
 * что снимок манифеста записан на интейк.
 */
const createFilesStub = () => ({
  trySaveText: jest.fn().mockResolvedValue({
    storageKey: 'input-manifest/2026/08/01/manifest.json',
    sha256: 'a'.repeat(64),
    sizeBytes: 100,
    contentType: 'application/json',
    fileName: 'manifest.json',
  }),
});

const makeIntake = (overrides: Record<string, unknown> = {}) => ({
  id: 'intake-1',
  workflowStatus: 'READY_FOR_AGENT',
  candidateTitle: 'Test Book',
  candidateAuthor: 'Test Author',
  originalTitle: null,
  originalLanguage: null,
  authorBirthYear: null,
  authorDeathYear: null,
  sourceProvider: 'PROJECT_GUTENBERG',
  sourceExternalId: '12345',
  sourceUrl: 'https://www.gutenberg.org/ebooks/12345',
  sourceTitle: null,
  sourceLanguage: 'en',
  sourceTextType: 'ORIGINAL_TEXT',
  targetLanguages: ['en', 'fr'],
  targetCountryCodes: ['US', 'GB', 'FR'],
  plannedContentTypes: ['TEXT', 'AUDIO'],
  plannedComponents: [],
  notesRu: null,
  ...overrides,
});

describe('RightsIntakeManifestService', () => {
  let service: RightsIntakeManifestService;
  let prisma: PrismaStub;
  let files: ReturnType<typeof createFilesStub>;

  beforeEach(() => {
    prisma = createPrismaStub();
    files = createFilesStub();
    service = new RightsIntakeManifestService(
      prisma as unknown as PrismaService,
      files as unknown as RightsFileStorageService,
    );
  });

  describe('generate', () => {
    it('generates manifest for READY_FOR_AGENT intake', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());

      const manifest = await service.generate('intake-1');

      expect(manifest.manifestVersion).toBe(RIGHTS_AGENT_MANIFEST_VERSION);
      expect(manifest.manifestType).toBe('BIBLIARIS_RIGHTS_CLEARANCE_INPUT');
      expect(manifest.intake.candidateTitle).toBe('Test Book');
      expect(manifest.intake.workflowStatus).toBe('READY_FOR_AGENT');
      expect(manifest.source.provider).toBe('PROJECT_GUTENBERG');
      expect(manifest.publicationPlan.targetLanguages).toEqual(['en', 'fr']);
      expect(manifest.agentTask.requiredChecks.length).toBeGreaterThan(0);
      expect(manifest.expectedResultSchema.requiredTopLevelFields).toContain('schemaVersion');
    });

    it('throws NotFoundException when intake missing', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(null);

      await expect(service.generate('missing')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for DRAFT', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake({ workflowStatus: 'DRAFT' }));

      await expect(service.generate('intake-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for ARCHIVED', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake({ workflowStatus: 'ARCHIVED' }));

      await expect(service.generate('intake-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for APPROVED', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake({ workflowStatus: 'APPROVED' }));

      await expect(service.generate('intake-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for REVIEW_IMPORTED', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ workflowStatus: 'REVIEW_IMPORTED' }),
      );

      await expect(service.generate('intake-1')).rejects.toThrow(BadRequestException);
    });

    // WP-10.3 (R4-04): фильтр статусов фазы 2 был чёрным списком и не знал о статусе фазы 19,
    // поэтому манифест выгружался посреди юридической проверки, а в `intake.workflowStatus`
    // манифеста уезжало значение, которого ТЗ фазы 2 там не допускает.
    it('throws BadRequestException for LAWYER_REVIEW_REQUIRED and stores nothing', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ workflowStatus: 'LAWYER_REVIEW_REQUIRED' }),
      );

      await expect(service.generate('intake-1')).rejects.toThrow(BadRequestException);
      expect(files.trySaveText).not.toHaveBeenCalled();
      expect(prisma.rightsIntake.update).not.toHaveBeenCalled();
    });

    it('normalizes plannedComponents null to []', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake({ plannedComponents: null }));

      const manifest = await service.generate('intake-1');
      expect(manifest.publicationPlan.plannedComponents).toEqual([]);
    });

    it('includes manifestVersion = 1.3', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());

      const manifest = await service.generate('intake-1');
      expect(manifest.manifestVersion).toBe('1.3');
    });

    it('includes expectedResultSchema.requiredTopLevelFields', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());

      const manifest = await service.generate('intake-1');
      expect(manifest.expectedResultSchema.requiredTopLevelFields).toEqual(
        expect.arrayContaining([
          'schemaVersion',
          'intakeId',
          'overallStatus',
          'summaryRu',
          'territoryDecisions',
          'evidence',
        ]),
      );
    });

    it('throws BadRequestException if targetLanguages is not array', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ targetLanguages: 'not-an-array' }),
      );

      await expect(service.generate('intake-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException if targetCountryCodes is not array', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake({ targetCountryCodes: null }));

      await expect(service.generate('intake-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException if plannedContentTypes is not array', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ plannedContentTypes: { foo: 'bar' } }),
      );

      await expect(service.generate('intake-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for REJECTED', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake({ workflowStatus: 'REJECTED' }));

      await expect(service.generate('intake-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for BOOK_CREATED', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ workflowStatus: 'BOOK_CREATED' }),
      );

      await expect(service.generate('intake-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for HUMAN_REVIEW_REQUIRED', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ workflowStatus: 'HUMAN_REVIEW_REQUIRED' }),
      );

      await expect(service.generate('intake-1')).rejects.toThrow(BadRequestException);
    });

    it('generatedAt is a valid ISO string', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());

      const manifest = await service.generate('intake-1');
      expect(() => new Date(manifest.generatedAt)).not.toThrow();
      expect(new Date(manifest.generatedAt).toISOString()).toBe(manifest.generatedAt);
    });

    it('includes generatedBy.product and generatedBy.module', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());

      const manifest = await service.generate('intake-1');
      expect(manifest.generatedBy.product).toBe('Bibliaris');
      expect(manifest.generatedBy.module).toBe('rights-intake');
    });
  });

  /**
   * WP-F.2 (исток Б1): манифест заказывал оценку обложки, озвучки, иллюстраций и перевода
   * независимо от плана публикации. Агент честно заводил спекулятивные `COVER` /
   * `AUDIO_NARRATION` со статусом `UNCERTAIN`, и именно они роняли все страны в
   * `PENDING_REVIEW`.
   */
  describe('WP-F.2: requiredChecks зависят от plannedComponents', () => {
    const joined = (parts: string[]): string => parts.join(' ').toLowerCase();

    it('интейк на ORIGINAL_TEXT не заказывает оценку озвучки, обложки и иллюстраций', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ plannedComponents: ['ORIGINAL_TEXT'] }),
      );

      const manifest = await service.generate('intake-1');
      const checks = joined(manifest.agentTask.requiredChecks);

      expect(checks).not.toContain('audio');
      expect(checks).not.toContain('cover');
      expect(checks).not.toContain('illustrat');
      expect(checks).not.toContain('translator');
    });

    it('интейк с COVER и AUDIO_NARRATION по-прежнему заказывает их оценку', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ plannedComponents: ['ORIGINAL_TEXT', 'COVER', 'AUDIO_NARRATION'] }),
      );

      const manifest = await service.generate('intake-1');
      const checks = joined(manifest.agentTask.requiredChecks);

      expect(checks).toContain('cover');
      expect(checks).toContain('audio');
    });

    it('перевод оценивается, если источник сам является переводом', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ plannedComponents: ['ORIGINAL_TEXT'], sourceTextType: 'TRANSLATION' }),
      );

      const manifest = await service.generate('intake-1');

      expect(joined(manifest.agentTask.requiredChecks)).toContain('translator');
    });

    it('без запланированных компонентов пустой componentAssessments объявлен ожидаемым ответом', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake({ plannedComponents: [] }));

      const manifest = await service.generate('intake-1');
      const notes = joined(manifest.expectedResultSchema.notes);

      expect(notes).toContain('componentassessments');
      expect(notes).toContain('empty array');
      // Ключ остаётся в контракте схемы 1.0: его отсутствие валидатор импорта считает ошибкой.
      expect(manifest.expectedResultSchema.requiredTopLevelFields).toContain(
        'componentAssessments',
      );
    });

    it('с запланированными компонентами пустой componentAssessments ожидаемым не объявляется', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ plannedComponents: ['ORIGINAL_TEXT', 'COVER'] }),
      );

      const manifest = await service.generate('intake-1');

      expect(joined(manifest.expectedResultSchema.notes)).not.toContain('empty array');
    });
  });

  /**
   * WP-F.3: восемь правил манифеста были только ограничительными, и `importantRules`
   * прямо толкали агента в `PENDING_REVIEW`. Ориентиры на разрешение обязаны быть
   * условными по юрисдикции и касаться только полноты отчёта.
   */
  describe('WP-F.3: симметричные importantRules', () => {
    it('ориентир на public domain сформулирован через срок охраны юрисдикции', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());

      const rules = (await service.generate('intake-1')).agentTask.importantRules.join(' ');

      expect(rules).toContain('life+70');
      expect(rules).toContain('life+80');
      expect(rules).toContain('1929');
    });

    it('оговорены Мексика (life+100) и французские военные продления', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());

      const rules = (await service.generate('intake-1')).agentTask.importantRules.join(' ');

      expect(rules).toContain('Mexico');
      expect(rules).toContain('life+100');
      expect(rules.toLowerCase()).toContain('wartime');
    });

    it('ориентир касается полноты отчёта и никогда — accessPolicy сервера', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());

      const rules = (await service.generate('intake-1')).agentTask.importantRules.join(' ');

      expect(rules).toContain('accessPolicy');
      // Обратная сторона: универсального «PD везде» в манифесте по-прежнему нет.
      expect(rules).toContain(
        'Do not assume that a text taken from any source site — Project Gutenberg, a wiki, a digital library — is globally public domain',
      );
      expect(rules.toLowerCase()).not.toContain('public domain worldwide');
    });
  });

  /**
   * WP-F.1: агент получал `provider: UNKNOWN` при очевидной ссылке на Gutenberg.
   * Нормализация — вывод приложения, поэтому она помечена `derivedFromUrl`.
   */
  describe('WP-F.1: нормализация источника по ссылке', () => {
    it('заполняет провайдера и ID из ссылки и помечает вывод приложения', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({
          sourceProvider: 'UNKNOWN',
          sourceExternalId: null,
          sourceUrl: 'https://www.gutenberg.org/ebooks/932',
        }),
      );

      const manifest = await service.generate('intake-1');

      expect(manifest.source.provider).toBe('PROJECT_GUTENBERG');
      expect(manifest.source.externalId).toBe('932');
      expect(manifest.source.derivedFromUrl).toBe(true);
    });

    /**
     * WP-M.1: незнакомый домен даёт `OTHER` и имя площадки в `providerHint`, но внешний ID
     * из адреса не выдумывается: у сайта, про который ничего не известно, нет каталога.
     */
    it('незнакомый домен даёт OTHER и хост в providerHint', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({
          sourceProvider: 'UNKNOWN',
          sourceExternalId: null,
          sourceUrl: 'https://example.com/books/932',
        }),
      );

      const manifest = await service.generate('intake-1');

      expect(manifest.source.provider).toBe('OTHER');
      expect(manifest.source.providerHint).toBe('example.com');
      expect(manifest.source.externalId).toBeNull();
    });
  });

  /**
   * WP-M.1: интейк перестал быть про один Gutenberg. Проверялось на живом кейсе «Преступление
   * и наказание» с ru.wikisource.org: провайдер оставался `UNKNOWN`, внешний ID редактор
   * заполнял строкой `null`, а заданию агента нечего было сказать про расшифровку сообщества.
   */
  describe('WP-M.1: источник любой площадки', () => {
    const WIKISOURCE_URL =
      'https://ru.wikisource.org/wiki/%D0%9F%D1%80%D0%B5%D1%81%D1%82%D1%83%D0%BF%D0%BB%D0%B5%D0%BD%D0%B8%D0%B5_%D0%B8_%D0%BD%D0%B0%D0%BA%D0%B0%D0%B7%D0%B0%D0%BD%D0%B8%D0%B5_(%D0%94%D0%BE%D1%81%D1%82%D0%BE%D0%B5%D0%B2%D1%81%D0%BA%D0%B8%D0%B9)';

    it('называет площадку и выводит ID страницы Викитеки', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({
          sourceProvider: 'UNKNOWN',
          sourceExternalId: null,
          sourceUrl: WIKISOURCE_URL,
        }),
      );

      const manifest = await service.generate('intake-1');

      expect(manifest.source.provider).toBe('OTHER');
      expect(manifest.source.providerHint).toBe('Wikisource (ru)');
      expect(manifest.source.externalId).toBe('Преступление_и_наказание_(Достоевский)');
    });

    it('заказывает проверку расшифровки и её лицензии, а не статуса Gutenberg', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ sourceProvider: 'OTHER', sourceUrl: WIKISOURCE_URL }),
      );

      const checks = (await service.generate('intake-1')).agentTask.requiredChecks.join(' ');

      expect(checks).toContain('community-edited transcription');
      expect(checks).toContain('licence of the transcription itself');
      expect(checks).not.toContain('Project Gutenberg status');
    });

    it('для Gutenberg по-прежнему заказывает его собственную проверку', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({
          sourceProvider: 'PROJECT_GUTENBERG',
          sourceUrl: 'https://www.gutenberg.org/ebooks/932',
        }),
      );

      const checks = (await service.generate('intake-1')).agentTask.requiredChecks.join(' ');

      expect(checks).toContain('Project Gutenberg status');
      expect(checks).not.toContain('community-edited transcription');
    });

    it('у незнакомого сайта требует назвать, кто и на каком основании выложил текст', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ sourceProvider: 'OTHER', sourceUrl: 'https://example.com/books/932' }),
      );

      const checks = (await service.generate('intake-1')).agentTask.requiredChecks.join(' ');

      expect(checks).toContain('not a known rights-bearing catalogue');
    });
  });

  /**
   * WP-F.5: `readiness` показывает пробелы интейка до отправки агенту и **никогда** не
   * блокирует ни манифест, ни переход статуса — блокирующая проверка сделала бы вход строже.
   */
  describe('WP-F.5: неблокирующий readiness', () => {
    it('перечисляет пробелы минимального пакета в любом статусе, включая DRAFT', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({
          workflowStatus: 'DRAFT',
          targetCountryCodes: [],
          sourceUrl: null,
          sourceExternalId: null,
          plannedComponents: [],
        }),
      );

      const readiness = await service.readiness('intake-1');
      const codes = readiness.missing.map((item) => item.code);

      expect(codes).toContain('TARGET_COUNTRIES_EMPTY');
      expect(codes).toContain('SOURCE_URL_MISSING');
      expect(codes).toContain('PLANNED_COMPONENTS_EMPTY');
      expect(readiness.isReady).toBe(false);
    });

    /**
     * WP-M.1: внешний ID переехал из `missing` в `warnings`. В `missing` он читался как
     * «заполни, иначе не поедет» — и редактор вписывал в поле строку `null`, лишь бы
     * список пробелов очистился.
     */
    it('внешний ID источника — предупреждение, а не пробел минимального пакета', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ sourceExternalId: null, plannedComponents: ['ORIGINAL_TEXT'] }),
      );

      const readiness = await service.readiness('intake-1');

      expect(readiness.missing.map((item) => item.code)).not.toContain(
        'SOURCE_EXTERNAL_ID_MISSING',
      );
      expect(readiness.warnings.map((item) => item.code)).toContain('SOURCE_EXTERNAL_ID_MISSING');
      expect(readiness.isReady).toBe(true);
    });

    it('полный интейк не даёт пробелов', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ plannedComponents: ['ORIGINAL_TEXT'] }),
      );

      const readiness = await service.readiness('intake-1');

      expect(readiness.missing).toEqual([]);
      expect(readiness.isReady).toBe(true);
    });

    it('пробелы не мешают выдать манифест — проверка неблокирующая', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(
        makeIntake({ targetCountryCodes: [], sourceUrl: null, plannedComponents: [] }),
      );

      const manifest = await service.generate('intake-1');

      expect(manifest.manifestVersion).toBe(RIGHTS_AGENT_MANIFEST_VERSION);
      expect(manifest.readiness.missing.length).toBeGreaterThan(0);
    });

    it('несуществующий интейк по-прежнему 404', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(null);

      await expect(service.readiness('missing')).rejects.toThrow(NotFoundException);
    });
  });

  /**
   * WP-9.1 (essence §15 `input_manifest_storage_key`). Манифест собирается на лету и несёт
   * `generatedAt`, поэтому повторный GET даёт другие байты: без снимка ответить «под каким
   * заданием агент писал отчёт» было бы нечем.
   */
  describe('WP-9.1: снимок манифеста', () => {
    it('сохраняет ровно те байты, которые уходят агенту', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());

      const manifest = await service.generate('intake-1');

      expect(files.trySaveText).toHaveBeenCalledWith(
        'input-manifest',
        JSON.stringify(manifest),
        'application/json',
        expect.stringContaining('intake-1'),
      );
    });

    it('запоминает ключ, сумму и версию на интейке', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());

      await service.generate('intake-1');

      const data = prisma.rightsIntake.update.mock.calls[0][0].data as Record<string, unknown>;
      expect(data.manifestStorageKey).toBe('input-manifest/2026/08/01/manifest.json');
      expect(data.manifestSha256).toBe('a'.repeat(64));
      expect(data.manifestVersion).toBe(RIGHTS_AGENT_MANIFEST_VERSION);
      expect(data.manifestGeneratedAt).toBeInstanceOf(Date);
    });

    it('отдаёт манифест редактору даже если хранилище недоступно', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());
      files.trySaveText.mockResolvedValue(null);

      const manifest = await service.generate('intake-1');

      expect(manifest.manifestVersion).toBe(RIGHTS_AGENT_MANIFEST_VERSION);
      expect(prisma.rightsIntake.update).not.toHaveBeenCalled();
    });

    /**
     * Тот случай, ради которого запись снимка обёрнута в try/catch: код выкатили раньше
     * миграции WP-9, колонок ещё нет — фаза 2 обязана продолжать работать.
     */
    it('отдаёт манифест, даже если колонок снимка ещё нет в базе', async () => {
      prisma.rightsIntake.findUnique.mockResolvedValue(makeIntake());
      prisma.rightsIntake.update.mockRejectedValue(
        new Error("Unknown argument 'manifestStorageKey'"),
      );

      const manifest = await service.generate('intake-1');

      expect(manifest.manifestVersion).toBe(RIGHTS_AGENT_MANIFEST_VERSION);
    });
  });
});

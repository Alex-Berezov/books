import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsFileStorageService } from '../../shared/rights-file-storage/rights-file-storage.service';
import {
  MANIFEST_GENERATABLE_INTAKE_STATUSES,
  RIGHTS_AGENT_MANIFEST_VERSION,
  RIGHTS_AGENT_MANIFEST_TYPE,
  RIGHTS_AGENT_EXPECTED_REPORT_SCHEMA_VERSION,
  RIGHTS_AGENT_REPORT_SCHEMA_URL,
  RIGHTS_AGENT_SUBMISSION_ENDPOINT,
} from './rights-intake.constants';
import { deriveSourceFromUrl, resolveSourceKind } from './rights-intake-source-url.util';
import type { DerivedSourceKind } from './rights-intake-source-url.util';
import type { RightsAgentManifestDto } from './dto/rights-agent-manifest.dto';
import type {
  RightsIntakeReadinessDto,
  RightsIntakeReadinessItemDto,
} from './dto/rights-intake-readiness.dto';

function assertArray(value: unknown, fieldName: string): asserts value is unknown[] {
  if (value === null || value === undefined || !Array.isArray(value)) {
    throw new BadRequestException(
      `Rights intake contains invalid manifest data: ${fieldName} must be an array`,
    );
  }
}

/** Компоненты, наличие которых в плане публикации включает соответствующий пункт задания. */
const TRANSLATION_COMPONENTS: readonly string[] = ['TRANSLATION'];
const COVER_COMPONENTS: readonly string[] = ['COVER'];
const AUDIO_COMPONENTS: readonly string[] = ['AUDIO_NARRATION', 'AUDIO_RECORDING'];
const VISUAL_COMPONENTS: readonly string[] = ['ILLUSTRATION', 'PHOTOGRAPH', 'MAP'];
const EDITORIAL_COMPONENTS: readonly string[] = [
  'INTRODUCTION',
  'PREFACE',
  'AFTERWORD',
  'ANNOTATIONS',
  'FOOTNOTES',
];

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

function gap(code: string, field: string, messageRu: string): RightsIntakeReadinessItemDto {
  return { code, field, messageRu };
}

interface ManifestIntakeRecord {
  id: string;
  workflowStatus: string;
  candidateTitle: string;
  candidateAuthor: string;
  originalTitle: string | null;
  originalLanguage: string | null;
  authorBirthYear: number | null;
  authorDeathYear: number | null;
  notesRu: string | null;
  sourceProvider: unknown;
  sourceExternalId: string | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourceLanguage: string | null;
  sourceTextType: unknown;
  targetLanguages: unknown;
  targetCountryCodes: unknown;
  plannedContentTypes: unknown;
  plannedComponents: unknown;
}

@Injectable()
export class RightsIntakeManifestService {
  private readonly logger = new Logger(RightsIntakeManifestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: RightsFileStorageService,
  ) {}

  async generate(id: string): Promise<RightsAgentManifestDto> {
    const intake = await this.prisma.rightsIntake.findUnique({ where: { id } });
    if (!intake) {
      throw new NotFoundException(`Rights intake with ID '${id}' not found`);
    }

    if (intake.workflowStatus === 'DRAFT') {
      throw new BadRequestException(
        'Cannot generate manifest for DRAFT intake. Mark it as READY_FOR_AGENT first.',
      );
    }

    // WP-10.3 (R4-04): белый список вместо чёрного — см. `MANIFEST_GENERATABLE_INTAKE_STATUSES`.
    if (!MANIFEST_GENERATABLE_INTAKE_STATUSES.includes(intake.workflowStatus)) {
      throw new BadRequestException(
        `Cannot generate manifest for intake in '${intake.workflowStatus}' status. ` +
          `Expected one of ${MANIFEST_GENERATABLE_INTAKE_STATUSES.join(', ')}.`,
      );
    }

    assertArray(intake.targetLanguages, 'targetLanguages');
    assertArray(intake.targetCountryCodes, 'targetCountryCodes');
    assertArray(intake.plannedContentTypes, 'plannedContentTypes');
    if (intake.plannedComponents !== null) {
      assertArray(intake.plannedComponents, 'plannedComponents');
    }

    const now = new Date().toISOString();

    // WP-F.5: пробелы интейка уезжают агенту как справка и остаются видимыми редактору.
    // Выдачу манифеста они не останавливают — блокирующая проверка сделала бы вход строже.
    const manifest = this.build(intake, now, this.assessReadiness(intake));

    // WP-9.1 (essence §15): манифест собирается на лету и несёт `generatedAt`, поэтому
    // повторный GET даёт другие байты — восстановить задним числом, что именно получил агент,
    // невозможно. Сохраняем ровно то, что уходит на провод, и запоминаем ключ на интейке;
    // импорт отчёта скопирует его в `inputManifest*`.
    // Best-effort: недоступность хранилища не должна отнимать у редактора манифест.
    const stored = await this.files.trySaveText(
      'input-manifest',
      JSON.stringify(manifest),
      'application/json',
      `rights-agent-manifest-${intake.id}.json`,
    );

    if (stored) {
      await this.rememberManifestSnapshot(intake.id, stored, now);
    }

    return manifest;
  }

  /**
   * WP-F.5: пробелы интейка до отправки агенту. Доступна в любом статусе — именно в `DRAFT`
   * она и нужна, — и **никогда** не запрещает ни манифест, ни смену статуса.
   */
  async readiness(id: string): Promise<RightsIntakeReadinessDto> {
    const intake = await this.prisma.rightsIntake.findUnique({ where: { id } });
    if (!intake) {
      throw new NotFoundException(`Rights intake with ID '${id}' not found`);
    }

    const { missing, warnings } = this.assessReadiness(intake as unknown as ManifestIntakeRecord);

    return { intakeId: intake.id, isReady: missing.length === 0, missing, warnings };
  }

  private assessReadiness(intake: ManifestIntakeRecord): {
    missing: RightsIntakeReadinessItemDto[];
    warnings: RightsIntakeReadinessItemDto[];
  } {
    const missing: RightsIntakeReadinessItemDto[] = [];
    const warnings: RightsIntakeReadinessItemDto[] = [];

    if (toStringArray(intake.targetCountryCodes).length === 0) {
      missing.push(
        gap('TARGET_COUNTRIES_EMPTY', 'targetCountryCodes', 'Не указана ни одна целевая страна.'),
      );
    }
    if (toStringArray(intake.targetLanguages).length === 0) {
      missing.push(
        gap('TARGET_LANGUAGES_EMPTY', 'targetLanguages', 'Не указан ни один целевой язык.'),
      );
    }
    if (isBlank(intake.sourceUrl)) {
      missing.push(gap('SOURCE_URL_MISSING', 'sourceUrl', 'Не указана ссылка на источник.'));
    }
    if (toStringArray(intake.plannedComponents).length === 0) {
      missing.push(
        gap(
          'PLANNED_COMPONENTS_EMPTY',
          'plannedComponents',
          'Не выбран ни один планируемый компонент — агент не поймёт, что именно оценивать.',
        ),
      );
    }

    // WP-M.1: внешний ID перестал быть пробелом уровня `missing`. Каталожный номер есть
    // у Gutenberg и цифровых библиотек, а у страницы Викитеки или у сайта издательства его
    // нет вовсе: в списке «чего не хватает» он заставлял редактора выдумывать значение —
    // в бою в это поле уехала строка `null`. Идентификатором источника остаётся ссылка.
    if (isBlank(intake.sourceExternalId)) {
      warnings.push(
        gap(
          'SOURCE_EXTERNAL_ID_MISSING',
          'sourceExternalId',
          'Не указан внешний ID источника — у площадок без каталожных номеров его и не бывает, ' +
            'источник опознаётся по ссылке.',
        ),
      );
    }
    if (intake.sourceProvider === 'UNKNOWN' || isBlank(intake.sourceProvider)) {
      warnings.push(
        gap('SOURCE_PROVIDER_UNKNOWN', 'sourceProvider', 'Провайдер источника не определён.'),
      );
    }
    if (intake.sourceTextType === 'UNKNOWN' || isBlank(intake.sourceTextType)) {
      warnings.push(
        gap('SOURCE_TEXT_TYPE_UNKNOWN', 'sourceTextType', 'Тип текста источника не определён.'),
      );
    }
    if (isBlank(intake.sourceLanguage)) {
      warnings.push(gap('SOURCE_LANGUAGE_MISSING', 'sourceLanguage', 'Не указан язык источника.'));
    }
    if (intake.authorDeathYear === null || intake.authorDeathYear === undefined) {
      warnings.push(
        gap(
          'AUTHOR_DEATH_YEAR_MISSING',
          'authorDeathYear',
          'Не указан год смерти автора — без него агенту нечем считать срок охраны.',
        ),
      );
    }
    if (toStringArray(intake.plannedContentTypes).length === 0) {
      warnings.push(
        gap('PLANNED_CONTENT_TYPES_EMPTY', 'plannedContentTypes', 'Не выбран формат публикации.'),
      );
    }

    return { missing, warnings };
  }

  /**
   * Снимок манифеста — вспомогательная запись, а не то, ради чего эндпоинт существует.
   * Поэтому её отказ не должен превращать выдачу манифеста в 500: и при недоступной базе,
   * и — важнее — если код выкатили раньше миграции WP-9, редактор всё равно получает файл,
   * а причина уходит в лог. Ответить «под каким заданием сделан отчёт» в этом случае будет
   * нечем, но это меньшая беда, чем неработающая фаза 2.
   */
  private async rememberManifestSnapshot(
    intakeId: string,
    stored: { storageKey: string; sha256: string },
    generatedAt: string,
  ): Promise<void> {
    try {
      await (
        this.prisma as unknown as {
          rightsIntake: { update: (args: Record<string, unknown>) => Promise<unknown> };
        }
      ).rightsIntake.update({
        where: { id: intakeId },
        data: {
          manifestStorageKey: stored.storageKey,
          manifestSha256: stored.sha256,
          manifestVersion: RIGHTS_AGENT_MANIFEST_VERSION,
          manifestGeneratedAt: new Date(generatedAt),
        },
      });
    } catch (e) {
      this.logger.warn(
        `Failed to record the agent manifest snapshot for intake ${intakeId}: ` +
          `${(e as Error).message}. The manifest itself was returned to the editor.`,
      );
    }
  }

  private build(
    intake: ManifestIntakeRecord,
    now: string,
    readiness: {
      missing: RightsIntakeReadinessItemDto[];
      warnings: RightsIntakeReadinessItemDto[];
    },
  ): RightsAgentManifestDto {
    const plannedComponents = toStringArray(intake.plannedComponents);
    const sourceTextType = typeof intake.sourceTextType === 'string' ? intake.sourceTextType : '';

    // WP-F.1: провайдер и внешний ID достраиваются из ссылки только там, где интейк их не
    // несёт. Признак `derivedFromUrl` говорит агенту, что перед ним догадка приложения.
    const derived = deriveSourceFromUrl(intake.sourceUrl);
    const storedProvider = typeof intake.sourceProvider === 'string' ? intake.sourceProvider : '';
    const providerIsGap = storedProvider === '' || storedProvider === 'UNKNOWN';
    const providerFromUrl = providerIsGap && derived?.provider != null;
    const provider = providerFromUrl ? (derived?.provider as string) : storedProvider;

    const externalIdIsGap = intake.sourceExternalId === null || intake.sourceExternalId === '';
    const externalIdFromUrl = externalIdIsGap && derived?.externalId != null;
    const externalId = externalIdFromUrl
      ? (derived?.externalId as string)
      : (intake.sourceExternalId ?? null);

    return {
      manifestVersion: RIGHTS_AGENT_MANIFEST_VERSION,
      manifestType: RIGHTS_AGENT_MANIFEST_TYPE,
      generatedAt: now,
      generatedBy: {
        product: 'Bibliaris',
        module: 'rights-intake',
      },
      intake: {
        id: intake.id,
        workflowStatus: intake.workflowStatus,
        candidateTitle: intake.candidateTitle,
        candidateAuthor: intake.candidateAuthor,
        originalTitle: intake.originalTitle,
        originalLanguage: intake.originalLanguage,
        authorBirthYear: intake.authorBirthYear,
        authorDeathYear: intake.authorDeathYear,
        notesRu: intake.notesRu,
      },
      source: {
        provider,
        // WP-M.1: `provider` — одно из трёх значений enum'а, и для всего, кроме Gutenberg, это
        // `OTHER`. Имя площадки агент берёт отсюда: «Wikisource (ru)», «Internet Archive»,
        // либо просто хост. Заводить значение enum'а на каждый сайт означало бы миграцию
        // на каждый новый источник.
        providerHint: derived?.providerHint ?? null,
        externalId,
        url: intake.sourceUrl,
        title: intake.sourceTitle,
        language: intake.sourceLanguage,
        textType: sourceTextType,
        /**
         * Признак означает ровно одно: провайдер или внешний ID подставлены приложением из
         * ссылки. Прежняя формула `provider === derived.provider` после WP-M.1 давала `true`
         * почти всегда — `OTHER` стало и результатом разбора, и тем значением, которое
         * редактор выбирает руками, — и агент переставал отличать догадку от факта.
         */
        derivedFromUrl: providerFromUrl || externalIdFromUrl,
      },
      publicationPlan: {
        targetLanguages: intake.targetLanguages as string[],
        targetCountryCodes: intake.targetCountryCodes as string[],
        plannedContentTypes: intake.plannedContentTypes as string[],
        plannedComponents: (intake.plannedComponents as string[]) ?? [],
      },
      agentTask: {
        objective:
          'Check whether Bibliaris may create and later publish this work and planned language/content versions, considering copyright status, source edition status, translation rights, component rights, target countries, required removals/replacements, and possible geo restrictions.',
        requiredChecks: this.buildRequiredChecks(
          plannedComponents,
          sourceTextType,
          resolveSourceKind(storedProvider, derived),
        ),
        requiredOutputs: this.buildRequiredOutputs(plannedComponents),
        importantRules: this.buildImportantRules(),
      },
      expectedResultSchema: {
        schemaVersion: RIGHTS_AGENT_EXPECTED_REPORT_SCHEMA_VERSION,
        format: 'json',
        schemaUrl: RIGHTS_AGENT_REPORT_SCHEMA_URL,
        requiredTopLevelFields: [
          'schemaVersion',
          'intakeId',
          'overallStatus',
          'publicationGate',
          'summaryRu',
          'conclusionRu',
          'sourceAssessment',
          'languageAssessments',
          'componentAssessments',
          'territoryDecisions',
          'requiredActions',
          'evidence',
          'confidence',
          'nextReviewAt',
        ],
        submission: {
          endpoint: RIGHTS_AGENT_SUBMISSION_ENDPOINT,
          method: 'POST',
          authHeader: 'X-Bibliaris-Agent-Token',
          note: 'Send the JSON report in the "report" field. The token is single-use and issued by a Bibliaris editor.',
        },
        notes: this.buildSchemaNotes(plannedComponents),
      },
      readiness: { missing: readiness.missing, warnings: readiness.warnings },
    };
  }

  /**
   * WP-F.2 (исток Б1): пункты про переводчика, обложку, озвучку и иллюстрации попадают в
   * задание только когда соответствующий компонент есть в плане публикации. Раньше их
   * заказывали всегда, агент честно заводил спекулятивные `COVER` / `AUDIO_NARRATION` со
   * статусом `UNCERTAIN`, и эти несуществующие материалы роняли страны в `PENDING_REVIEW`.
   */
  private buildRequiredChecks(
    plannedComponents: string[],
    sourceTextType: string,
    sourceKind: DerivedSourceKind | null,
  ): string[] {
    const has = (group: readonly string[]): boolean =>
      plannedComponents.some((component) => group.includes(component));

    const checks = [
      'Identify whether the source edition is an original text, translation, adaptation, abridgment, compilation, or unknown.',
      // WP-M.1: раньше здесь стоял один пункт про Project Gutenberg, и на любом другом
      // источнике агент не получал задания разобраться в правах самой площадки.
      'Check the source site itself: its licence, terms of use, and any rights it claims over the digitisation, transcription or scan it publishes.',
      ...this.buildSourceKindChecks(sourceKind),
      'Check whether the original work appears to be public domain in target countries.',
      'Check whether the source edition itself appears to be public domain or otherwise usable in target countries.',
      'Identify the author and every contributor whose work is part of the planned components, with life dates, nationality, authority IDs (VIAF/LoC), and identity confidence.',
    ];

    if (has(TRANSLATION_COMPONENTS) || sourceTextType === 'TRANSLATION') {
      checks.push(
        'Check whether translator rights may affect publication, and identify the translator.',
      );
    }
    if (has(COVER_COMPONENTS)) {
      checks.push('Check whether cover rights may affect publication.');
    }
    if (has(AUDIO_COMPONENTS)) {
      checks.push('Check whether audio narration or recording rights may affect publication.');
    }
    if (has(VISUAL_COMPONENTS)) {
      checks.push('Check whether illustration, photograph or map rights may affect publication.');
    }
    if (has(EDITORIAL_COMPONENTS)) {
      checks.push(
        'Check whether editorial rights on introduction, preface, afterword, annotations or footnotes may affect publication.',
      );
    }

    checks.push(
      'Check each planned target language separately.',
      'Check each target country separately, not only regions.',
      'Identify countries where publication should be allowed, blocked, license-required, pending review, or not targeted.',
      'Identify required actions before book creation or publication.',
      'Identify whether geo restrictions are required.',
      'Check whether a license is required for each target market and each planned component.',
      'If publication is possible only under a license, fill in the licenses[] block and set licenseRef in component and country decisions.',
      'Collect evidence URLs, source titles, jurisdictions, excerpts or summaries, and access dates.',
      'Call out uncertainty explicitly instead of guessing.',
    );

    return checks;
  }

  /**
   * WP-M.1: пункты, зависящие от вида площадки. Права у Gutenberg, у Викитеки и у случайного
   * сайта устроены по-разному, и общий пункт «проверь источник» этой разницы не передаёт:
   * у Gutenberg — американское заявление о PD и своя обвязка в файле, у Викитеки — расшифровка
   * сообщества под собственной лицензией поверх конкретного бумажного издания, у незнакомого
   * сайта неизвестно даже, вправе ли он был выкладывать текст.
   */
  private buildSourceKindChecks(sourceKind: DerivedSourceKind | null): string[] {
    switch (sourceKind) {
      case 'GUTENBERG':
        return [
          'Check Project Gutenberg status and notices for this ebook, and treat its public-domain claim as a statement about the United States, not about the target countries.',
        ];
      case 'COMMUNITY_WIKI':
        return [
          'The source is a community-edited transcription: identify the printed edition it reproduces and assess the rights of that edition separately from the rights of the work.',
          'Check the licence of the transcription itself (Wikisource and related projects publish under CC BY-SA or a public-domain dedication) and state what attribution or share-alike duty it imposes on Bibliaris.',
          'Check whether the page carries editorial matter added by contributors — notes, prefaces, modernised spelling — and whether it is part of the planned components.',
        ];
      case 'DIGITAL_LIBRARY':
        return [
          'The source is a digital library: check the rights statement attached to this particular item, which may be narrower than the rights of the work itself.',
          'Check whether the item is a scan of a specific edition and whether that edition, its typography or its apparatus carry separate rights in the target countries.',
        ];
      case 'UNKNOWN_WEB':
        return [
          'The source site is not a known rights-bearing catalogue: state what the site is, who published the text there, and whether that publication itself appears to be lawful.',
          'Do not treat the presence of a text on this site as evidence of its rights status.',
        ];
      default:
        return [];
    }
  }

  private buildRequiredOutputs(plannedComponents: string[]): string[] {
    const outputs = [
      'Human-readable Russian summary.',
      'Final recommendation.',
      'Country-level decisions.',
      'Language-level rights notes.',
    ];

    if (plannedComponents.length > 0) {
      outputs.push('Component-level rights notes.');
    }

    outputs.push(
      'Required actions.',
      'Evidence list.',
      'Confidence level.',
      'Structured JSON compatible with the expected schema.',
    );

    return outputs;
  }

  /**
   * WP-F.3: восемь правил задания были только ограничительными, поэтому осторожный агент
   * уходил в `PENDING_REVIEW` даже на чистом public domain. Ориентиры на разрешение
   * добавлены **условными по юрисдикции** — универсального «PD везде» не существует — и
   * касаются только полноты отчёта: `accessPolicy` сервер из них никогда не выводит (ADR-006).
   */
  private buildImportantRules(): string[] {
    return [
      // WP-M.1: правило было написано под один источник, и на Викитеке или в цифровой
      // библиотеке агент его к себе не относил.
      'Do not assume that a text taken from any source site — Project Gutenberg, a wiki, a digital library — is globally public domain: such a claim is always made for one jurisdiction.',
      'The rights of the work, the rights of the edition reproduced, and the rights of the digitisation or transcription itself are three separate questions. Answer all three whenever the source site is not the original publisher.',
      'Do not treat a translation as equivalent to the original work.',
      'Do not collapse country-level decisions into broad regional decisions.',
      'If data is insufficient, mark it as insufficient data or pending review.',
      'If license is required, say so explicitly.',
      'If publication is possible only with geo restrictions, list countries to block.',
      'If an intermediate translation is used as a source, evaluate rights for both the original work and the intermediate translation.',
      'The result is not approved automatically; a Bibliaris human reviewer must approve it later.',
      'A public-domain answer is an expected outcome, not a failure: when the evidence supports it, answer ALLOWED instead of falling back to pending review.',
      'Term orientation, not a rule of law: in jurisdictions with a life+70 or life+80 term, an original text whose author died more than 100 years ago is normally already in the public domain — verify it country by country instead of defaulting to pending review.',
      'The orientation above does not hold everywhere: Mexico applies life+100, France adds wartime extensions, and some jurisdictions restored expired rights — check such countries separately.',
      'United States orientation: works published before 1929 are in the public domain there.',
      'These orientations concern only the completeness of your report. Bibliaris never derives accessPolicy from them: every country decision is yours and must rest on evidence.',
      'Assess only the components listed in publicationPlan.plannedComponents. A speculative component that nobody plans to publish blocks the whole release.',
    ];
  }

  private buildSchemaNotes(plannedComponents: string[]): string[] {
    const notes = [
      'The agent may submit the result directly to the submission endpoint using the one-time upload token, or the editor may paste it manually.',
      'A submitted report is never auto-approved: a Bibliaris human reviewer must approve it.',
      'The external agent should return JSON plus a human-readable report; both are accepted by the submission endpoint in the "report" and "reportMarkdown" fields.',
      'The optional licenses[] block describes licenses and permissions; licenses[].key values are referenced from licenseRef/licenseRefs.',
    ];

    // WP-F.2: `componentAssessments` перестаёт быть безусловно заполняемым полем. Ключ
    // остаётся обязательным по схеме 1.0 — его отсутствие валидатор импорта считает ошибкой, —
    // но без запланированных компонентов ожидаемый ответ именно пустой массив.
    notes.push(
      plannedComponents.length > 0
        ? 'componentAssessments must cover only the components listed in publicationPlan.plannedComponents.'
        : 'componentAssessments must cover only the components listed in publicationPlan.plannedComponents. None are planned for this intake, so an empty array is the expected answer; the key itself must still be present.',
    );

    return notes;
  }
}

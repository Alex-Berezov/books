import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  RIGHTS_AGENT_MANIFEST_VERSION,
  RIGHTS_AGENT_MANIFEST_TYPE,
  RIGHTS_AGENT_EXPECTED_REPORT_SCHEMA_VERSION,
  RIGHTS_AGENT_REPORT_SCHEMA_URL,
  RIGHTS_AGENT_SUBMISSION_ENDPOINT,
} from './rights-intake.constants';
import type { RightsAgentManifestDto } from './dto/rights-agent-manifest.dto';

function assertArray(value: unknown, fieldName: string): asserts value is unknown[] {
  if (value === null || value === undefined || !Array.isArray(value)) {
    throw new BadRequestException(
      `Rights intake contains invalid manifest data: ${fieldName} must be an array`,
    );
  }
}

@Injectable()
export class RightsIntakeManifestService {
  constructor(private readonly prisma: PrismaService) {}

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

    if (intake.workflowStatus === 'ARCHIVED') {
      throw new BadRequestException('Cannot generate manifest for ARCHIVED intake.');
    }

    const terminalOrFutureStatuses = [
      'APPROVED',
      'REJECTED',
      'BOOK_CREATED',
      'REVIEW_IMPORTED',
      'HUMAN_REVIEW_REQUIRED',
    ];
    if (terminalOrFutureStatuses.includes(intake.workflowStatus)) {
      throw new BadRequestException(
        `Cannot generate manifest for intake in '${intake.workflowStatus}' status. ` +
          'Manifest must be generated before importing the review.',
      );
    }

    assertArray(intake.targetLanguages, 'targetLanguages');
    assertArray(intake.targetCountryCodes, 'targetCountryCodes');
    assertArray(intake.plannedContentTypes, 'plannedContentTypes');
    if (intake.plannedComponents !== null) {
      assertArray(intake.plannedComponents, 'plannedComponents');
    }

    const now = new Date().toISOString();

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
        provider: intake.sourceProvider as string,
        externalId: intake.sourceExternalId,
        url: intake.sourceUrl,
        title: intake.sourceTitle,
        language: intake.sourceLanguage,
        textType: intake.sourceTextType as string,
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
        requiredChecks: [
          'Identify whether the source edition is an original text, translation, adaptation, abridgment, compilation, or unknown.',
          'Check Project Gutenberg status and notices if the source provider is PROJECT_GUTENBERG.',
          'Check whether the original work appears to be public domain in target countries.',
          'Check whether the source edition itself appears to be public domain or otherwise usable in target countries.',
          'Check whether translator/editor/illustrator/cover/audio-related rights may affect publication.',
          'Identify all contributors (author, translator, editor, illustrator, photographer, cover designer, etc.) with life dates, nationality, authority IDs (VIAF/LoC), and identity confidence.',
          'Check each planned target language separately.',
          'Check each target country separately, not only regions.',
          'Identify countries where publication should be allowed, blocked, license-required, pending review, or not targeted.',
          'Identify required actions before book creation or publication.',
          'Identify whether geo restrictions are required.',
          'Check whether a license is required for each target market and each component.',
          'If publication is possible only under a license, fill in the licenses[] block and set licenseRef in component and country decisions.',
          'Collect evidence URLs, source titles, jurisdictions, excerpts or summaries, and access dates.',
          'Call out uncertainty explicitly instead of guessing.',
        ],
        requiredOutputs: [
          'Human-readable Russian summary.',
          'Final recommendation.',
          'Country-level decisions.',
          'Language-level rights notes.',
          'Component-level rights notes.',
          'Required actions.',
          'Evidence list.',
          'Confidence level.',
          'Structured JSON compatible with the expected schema.',
        ],
        importantRules: [
          'Do not assume that a Gutenberg file is globally public domain.',
          'Do not treat a translation as equivalent to the original work.',
          'Do not collapse country-level decisions into broad regional decisions.',
          'If data is insufficient, mark it as insufficient data or pending review.',
          'If license is required, say so explicitly.',
          'If publication is possible only with geo restrictions, list countries to block.',
          'If an intermediate translation is used as a source, evaluate rights for both the original work and the intermediate translation.',
          'The result is not approved automatically; a Bibliaris human reviewer must approve it later.',
        ],
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
        notes: [
          'The agent may submit the result directly to the submission endpoint using the one-time upload token, or the editor may paste it manually.',
          'A submitted report is never auto-approved: a Bibliaris human reviewer must approve it.',
          'The external agent should return JSON plus a human-readable report; both are accepted by the submission endpoint in the "report" and "reportMarkdown" fields.',
          'The optional licenses[] block describes licenses and permissions; licenses[].key values are referenced from licenseRef/licenseRefs.',
        ],
      },
    };
  }
}

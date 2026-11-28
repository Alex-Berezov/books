import { ApiProperty } from '@nestjs/swagger';
import { ContentDraftStatus, Language, LlmOperationStatus, LlmPauseReason } from '@prisma/client';
import { LLM_MONEY_PROPERTY } from '../../llm/dto/llm-response.dto';
import { LlmOperationDto } from '../../llm-worker/dto/llm-operation.dto';
import {
  BookAnalysisFaqDto,
  BookAnalysisSourceDto,
} from '../../book-analysis/dto/book-analysis-blocks.dto';
import {
  BookWorldAdaptationDto,
  BookWorldArcDto,
  BookWorldCompareDto,
  BookWorldProfileDto,
  BookWorldQuoteDto,
  BookWorldRelationDto,
  BookWorldSceneDto,
} from '../../book-world/dto/book-world-blocks.dto';
import { WORLD_REMARK_CODES, WorldRemarkCode } from '../draft-quality/text-checks';
import {
  WORLD_BLOCKS,
  WORLD_FIX_CODES,
  WORLD_ITEM_OUTCOMES,
  WORLD_EVENTS_OFF_REASONS,
  WORLD_OBJECTS_OFF_REASONS,
  WORLD_PAIRS_OFF_REASONS,
  WORLD_PLACES_OFF_REASONS,
  WORLD_REVIEW_KINDS,
  WORLD_SKIP_REASONS,
  WORLD_STEP_KINDS,
  WORLD_STEP_SOURCES,
  WORLD_TERMS_OFF_REASONS,
  WORLD_VERDICTS,
  WorldBlock,
  WorldFixCode,
  WorldItemOutcome,
  WorldEventsOffReason,
  WorldObjectsOffReason,
  WorldPairsOffReason,
  WorldPlacesOffReason,
  WorldSkipReason,
  WorldStepKind,
  WorldStepSource,
  WorldTermsOffReason,
  WorldVerdict,
} from '../world-write/world-write.data';
import {
  WORLD_ACCEPT_ALL_SKIP_CODES,
  WorldAcceptAllSkipCode,
} from '../world-write/world-write.constants';
import { CompareContextLineDto, DossierContextLineDto } from './translation-compare-response.dto';

/**
 * Ход мира «Write World» (`F08-4a`; `features/F08-book-wiki/tech.md` §5): старт, оценка и чтение
 * хода - по образцу хода анализа. Содержимое блоков в ответ хода не идёт: записанный блок читается
 * ручкой мира, предложение - `GET content-drafts/:id/items/:index` (`WorldWriteValueDto`).
 * Response DTO - только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 */

export class WorldWriteEstimateDto {
  @ApiProperty({
    type: DossierContextLineDto,
    nullable: true,
    description: 'The dossier is built first by its own operation; null - it is ready',
  })
  dossier!: DossierContextLineDto | null;

  @ApiProperty({
    type: CompareContextLineDto,
    nullable: true,
    description:
      'The glossary of the version language is built first; null - ready or not needed (the version is in the dossier language)',
  })
  glossary!: CompareContextLineDto | null;

  @ApiProperty({
    type: Number,
    description:
      'Up to N candidates: the main and the secondary characters of the analysis of the version, before the chapter threshold of the secondary ones (an upper bound even when upperBound is false); one page each',
  })
  candidates!: number;

  @ApiProperty({
    type: Number,
    description:
      'Up to N pair pages (F08-8e): min(10, candidates·(candidates−1)/2) before the chapter count, 0 on a language without a pair sample; one page each, included in stageUsd',
  })
  pairs!: number;

  @ApiProperty({
    type: Number,
    description:
      'Up to N place pages (F08-12b): min(10, places of the dossier) before the chapter count (10 when the dossier is not ready), 0 on a language without a place sample; one page each, included in stageUsd',
  })
  places!: number;

  @ApiProperty({
    type: Number,
    description:
      'Up to N object pages (F08-13b): min(10, objects of the dossier) before the chapter count (10 when the dossier is not ready), 0 on a language without an object sample; one page each, included in stageUsd',
  })
  objects!: number;

  @ApiProperty({
    type: Number,
    description:
      'Up to N term pages (F08-13b): min(10, terms of the dossier) before the chapter count (10 when the dossier is not ready), 0 on a language without a term sample; one page each, included in stageUsd',
  })
  terms!: number;

  @ApiProperty({
    type: Number,
    description:
      'Up to N event pages (F08-13b-2): 10 (the choice step has not named the events yet), 0 on a language without an event sample; one page each, included in stageUsd',
  })
  events!: number;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    description:
      'Upper estimate: the choice of name forms on the whole version text, then per main and secondary character (before the chapter threshold) the page on the whole version text and the external blocks, then up to pairs pair pages, up to places place pages, up to objects object pages, up to terms term pages and up to events event pages on the whole version text, plus the reviewer of each step, each step × 2 passes',
  })
  stageUsd!: string;

  @ApiProperty({
    type: Boolean,
    description: 'The dossier or the glossary is not ready: their size is taken from their stages',
  })
  upperBound!: boolean;

  @ApiProperty({
    ...LLM_MONEY_PROPERTY,
    description: 'Default operation limit: max(steps × 1.5, dossier and glossary limits)',
  })
  suggestedLimitUsd!: string;
}

/** Замечание хода мира: только коды, которые ход ставит (`WORLD_REMARK_CODES`). */
export class WorldWriteRemarkDto {
  @ApiProperty({ enum: WORLD_REMARK_CODES })
  code!: WorldRemarkCode;

  @ApiProperty({ type: String, description: 'The field path and a short fragment, or the step' })
  where!: string;

  @ApiProperty({ type: String, description: 'What to fix, in English' })
  note!: string;

  @ApiProperty({ enum: ['code', 'model'] })
  by!: 'code' | 'model';
}

export class WorldWriteReviewDto {
  @ApiProperty({
    enum: WORLD_REVIEW_KINDS,
    description:
      'answered - the reviewer model checked the step; otherwise why the model check was not done',
  })
  kind!: (typeof WORLD_REVIEW_KINDS)[number];

  @ApiProperty({ type: String, nullable: true, description: 'The reviewer model (answered)' })
  model!: string | null;
}

export class WorldWriteFixDto {
  @ApiProperty({
    enum: WORLD_FIX_CODES,
    description:
      'What the code removed: an element that does not pass the import, a chapter not of the version, a tail over the limit, a quotation not word for word, a name form not in the text, an unknown key, a source that did not open or is not about the book, a statement without a checked source',
  })
  code!: WorldFixCode;

  @ApiProperty({ type: String, description: 'Path in the answer of the step' })
  path!: string;

  @ApiProperty({ type: String })
  note!: string;
}

export class WorldWriteDroppedQuoteDto {
  @ApiProperty({ type: String, description: 'Key of the character' })
  key!: string;

  @ApiProperty({ type: Number, nullable: true })
  chapter!: number | null;

  @ApiProperty({ type: String })
  text!: string;

  @ApiProperty({ enum: ['QUOTE_NOT_VERBATIM', 'CHAPTER_UNKNOWN'] })
  reason!: 'QUOTE_NOT_VERBATIM' | 'CHAPTER_UNKNOWN';
}

export class WorldWriteDroppedSourceDto {
  @ApiProperty({ type: String, description: 'Key of the character' })
  key!: string;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({
    type: String,
    description: 'Host of the address (the address itself is not kept)',
  })
  host!: string;

  @ApiProperty({ enum: ['SOURCE_UNREACHABLE', 'SOURCE_UNRELATED'] })
  reason!: 'SOURCE_UNREACHABLE' | 'SOURCE_UNRELATED';
}

export class WorldWriteCandidateDto {
  @ApiProperty({ type: String })
  key!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: [String], description: 'Name forms found in the text of the version' })
  aliases!: string[];

  @ApiProperty({
    type: [Number],
    description: 'Chapters where the name forms found the character (counted before the page)',
  })
  chapters!: number[];
}

/** Пара хода (`F08-8e`): два героя-кандидата хода, шаг пары - после шагов героев. */
export class WorldWritePairDto {
  @ApiProperty({ type: String, description: 'Key of the pair {a}--{b}' })
  key!: string;

  @ApiProperty({ type: String, description: 'Key of the first character of the pair key' })
  a!: string;

  @ApiProperty({ type: String, description: 'Key of the second character of the pair key' })
  b!: string;

  @ApiProperty({
    type: Boolean,
    description: 'The characters are related in the analysis of the version',
  })
  linked!: boolean;

  @ApiProperty({
    type: [Number],
    description: 'Chapters where both characters are (counted at the choice step)',
  })
  chapters!: number[];
}

/**
 * Место хода (`F08-12b`): место досье, прошедшее порог глав; шаг места - после шагов пар. Та же форма -
 * у предмета и понятия хода (`F08-13b`, `objects`, `terms`): поля одни, свой класс был бы копией.
 */
export class WorldWritePlaceDto {
  @ApiProperty({
    type: String,
    description: 'Key of the place, the object or the term (the dossier key)',
  })
  key!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: [String], description: 'Name forms found in the text of the version' })
  aliases!: string[];

  @ApiProperty({
    type: [Number],
    description:
      'Chapters where the name forms found the place, the object or the term (counted at the choice step)',
  })
  chapters!: number[];
}

/**
 * Отсеянный шагом выбора герой, пара, место, предмет, понятие или организация досье (`F08-8e`,
 * `F08-12b`, `F08-13b`): в ход не вошёл, вызова не было.
 */
export class WorldWriteSkipDto {
  @ApiProperty({
    type: String,
    description:
      'Key of the character, the pair, the place, the object, the term, the event or the organization',
  })
  key!: string;

  @ApiProperty({
    enum: WORLD_SKIP_REASONS,
    description:
      'BELOW_MIN_CHAPTERS - a secondary character in fewer chapters than the threshold; KEY_PAIR_FORM - a character key holds "--"; PAIR_KEY_INVALID - no pair key for these characters (longer than 60 or "-" at the joint); PAIR_KEY_TAKEN - the pair key belongs to an entity of another type; PAIRS_MAX - over 10 pairs per run; PLACE_BELOW_MIN_CHAPTERS - a place in fewer than 2 chapters; PLACE_KEY_TAKEN - the place key belongs to an entity or a candidate of another type; PLACES_MAX - over 10 places per run (F08-12b); OBJECT_BELOW_MIN_CHAPTERS, TERM_BELOW_MIN_CHAPTERS - an object or a term of the dossier found in no chapter; OBJECT_KEY_TAKEN, TERM_KEY_TAKEN - the key belongs to an entity or a candidate of another type (a character of the analysis, a pair of the run, a place of the dossier, for a term also an object of the dossier); OBJECTS_MAX, TERMS_MAX - over 10 objects or terms per run, by chapters then by key; ORGANIZATION_SKIPPED - an organization of the dossier, the run writes no page for it (F08-13b); EVENT_NO_CHAPTER - an event the choice step named without any chapter of the version; EVENT_KEY_TAKEN - the event key belongs to an entity or a candidate of another type, or to another event of the answer whose long name gives the same cut key; EVENT_KEY_INVALID - no key can be built for the event (from another version or from the name); EVENTS_MAX - over 10 events per run, by chapters then by key (F08-13b-2)',
  })
  reason!: WorldSkipReason;

  @ApiProperty({
    type: [String],
    description:
      'Names to caption the entry: one for a character, a place, an object, a term or an organization, two for a pair in key order; empty for a run saved before this field',
  })
  names!: string[];

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Chapters of the character, the place, the object or the term, or common chapters of the pair; null for a taken key and an organization',
  })
  chapters!: number | null;
}

export class WorldWriteStepDto {
  @ApiProperty({
    type: Number,
    description:
      '0 - the choice of name forms, then page and external blocks per character, then one step per pair, per place, per object and per term (F08-13b), then per event (F08-13b-2; none for a run started before it)',
  })
  step!: number;

  @ApiProperty({ enum: WORLD_STEP_KINDS })
  kind!: WorldStepKind;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Key of the character, the pair, the place, the object or the term; null - the choice step',
  })
  key!: string | null;

  @ApiProperty({ enum: WORLD_VERDICTS })
  verdict!: WorldVerdict;

  @ApiProperty({ type: [WorldWriteRemarkDto] })
  remarks!: WorldWriteRemarkDto[];

  @ApiProperty({
    type: Number,
    description: '1 - no redo or the redo gave no answer; 2 - the redo',
  })
  attempt!: number;

  @ApiProperty({ enum: ['done', 'failed'] })
  outcome!: 'done' | 'failed';

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why the step failed: DRAFT_TOO_LONG, DRAFT_INVALID_RESPONSE, WORLD_CHARACTER_NOT_FOUND (the name forms found the character in no chapter); a pair step without a call: WORLD_PAIR_MEMBER_MISSING (a character of the pair is not in the world), WORLD_PAIR_KEY_TAKEN, WORLD_PAIR_NOT_FOUNDED (a pair not linked in the analysis has no shared chapters - new or stored; or a new pair is not founded by the saved presence), WORLD_MENTIONS_MOVED (the text moved during the presence recount); a place step (F08-12b): WORLD_PLACE_NOT_FOUND (the name forms found the place in no chapter), without a call - WORLD_PLACE_KEY_TAKEN (the place key belongs to an entity of another type); an object or a term step (F08-13b), both without a call: WORLD_OBJECT_NOT_FOUND, WORLD_TERM_NOT_FOUND (the name forms found it in no chapter), WORLD_OBJECT_KEY_TAKEN, WORLD_TERM_KEY_TAKEN (the key got an entity of another type after the choice); WORLD_STEP_OUT_OF_RUN - the step number is past every list of the run (the run data does not match its count)',
  })
  failedReason!: string | null;

  @ApiProperty({ type: String, nullable: true })
  authorModel!: string | null;

  @ApiProperty({ type: WorldWriteReviewDto, nullable: true })
  review!: WorldWriteReviewDto | null;

  @ApiProperty({
    enum: WORLD_STEP_SOURCES,
    nullable: true,
    description:
      'text - the chapters with the character; top - the chapters with the most mentions and the chapter summaries; none - no book text',
  })
  source!: WorldStepSource | null;

  @ApiProperty({ type: [WorldWriteFixDto] })
  dropped!: WorldWriteFixDto[];
}

/** Вид места и номер Wikidata одним пунктом (`F08-12b`, решение арбитра `F08 | F08-12b` R3). */
export class WorldWritePlaceKindDto {
  @ApiProperty({ type: String, enum: ['real', 'fictional'], nullable: true })
  kind!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Wikidata item (Q…) of a real place' })
  wikidataId!: string | null;
}

/** Содержимое предложения: ровно одно поле по блоку, остальные `null`. */
export class WorldWriteValueDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'short, appearance, character, critique, prototypes, bonds, differences, conclusion, imageBrief; places (F08-12b) - location, significance, description; objects and terms (F08-13b) - significance, description (a term has no description); events (F08-13b-2) - significance; the scenes of a place or an event go in scenes',
  })
  text!: string | null;

  @ApiProperty({ type: [String], nullable: true })
  aliases!: string[] | null;

  @ApiProperty({ type: BookWorldProfileDto, nullable: true })
  profile!: BookWorldProfileDto | null;

  @ApiProperty({ type: BookWorldArcDto, nullable: true })
  arc!: BookWorldArcDto | null;

  @ApiProperty({ type: [BookWorldSceneDto], nullable: true })
  scenes!: BookWorldSceneDto[] | null;

  @ApiProperty({ type: [BookWorldRelationDto], nullable: true })
  relations!: BookWorldRelationDto[] | null;

  @ApiProperty({ type: [BookWorldQuoteDto], nullable: true })
  quotes!: BookWorldQuoteDto[] | null;

  @ApiProperty({ type: [BookAnalysisFaqDto], nullable: true })
  faq!: BookAnalysisFaqDto[] | null;

  @ApiProperty({ type: [BookWorldAdaptationDto], nullable: true })
  adaptations!: BookWorldAdaptationDto[] | null;

  @ApiProperty({
    type: [BookWorldCompareDto],
    nullable: true,
    description: 'Pair comparison table',
  })
  compare!: BookWorldCompareDto[] | null;

  @ApiProperty({
    type: WorldWritePlaceKindDto,
    nullable: true,
    description:
      'The kind item of a place (F08-12b, R3): real or fictional with its Wikidata item, one proposal',
  })
  place!: WorldWritePlaceKindDto | null;

  @ApiProperty({
    type: [String],
    nullable: true,
    description:
      'The characterKeys item of an object (F08-13b): keys of the characters of the world of this version',
  })
  characterKeys!: string[] | null;

  @ApiProperty({
    type: [String],
    nullable: true,
    description:
      'The themeKeys item of an object (F08-13b): keys of the themes of the analysis of this version',
  })
  themeKeys!: string[] | null;

  @ApiProperty({
    type: [BookAnalysisSourceDto],
    nullable: true,
    description:
      'Checked sources of an external block: «Accept» adds them to the sources of the entity',
  })
  sources!: BookAnalysisSourceDto[] | null;

  @ApiProperty({
    type: String,
    description: 'Print of the proposal: send it as expectedPrint of «Accept»',
  })
  print!: string;
}

export class WorldWriteItemDto {
  @ApiProperty({ type: Number })
  index!: number;

  @ApiProperty({ type: String, description: 'Key of the world entity' })
  key!: string;

  @ApiProperty({ enum: WORLD_BLOCKS })
  block!: WorldBlock;

  @ApiProperty({ type: Number })
  step!: number;

  @ApiProperty({ enum: WORLD_VERDICTS })
  verdict!: WorldVerdict;

  @ApiProperty({ type: [WorldWriteRemarkDto] })
  remarks!: WorldWriteRemarkDto[];

  @ApiProperty({ type: WorldWriteReviewDto, nullable: true })
  review!: WorldWriteReviewDto | null;

  @ApiProperty({
    enum: WORLD_ITEM_OUTCOMES,
    description:
      'waiting - the write is not decided yet; written - in the entity; proposed - a proposal; accepted, discarded - the editor decision; none - not written (failedReason)',
  })
  outcome!: WorldItemOutcome;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why the block is not written: IMPORT_INVALID, EXTERNAL_UNVERIFIED (no checked source), WORLD_WRITE_REFUSED (the world import refused)',
  })
  failedReason!: string | null;

  @ApiProperty({ type: String, nullable: true })
  regenFailedReason!: string | null;

  @ApiProperty({ type: Boolean, description: 'A regeneration of this block is running' })
  regenerating!: boolean;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  regenOperationId!: string | null;

  @ApiProperty({ enum: LlmOperationStatus, enumName: 'LlmOperationStatus', nullable: true })
  regenOperationStatus!: LlmOperationStatus | null;

  @ApiProperty({ enum: LlmPauseReason, enumName: 'LlmPauseReason', nullable: true })
  regenPauseReason!: LlmPauseReason | null;
}

export class WorldWriteDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  bookVersionId!: string;

  @ApiProperty({ enum: ContentDraftStatus })
  status!: ContentDraftStatus;

  @ApiProperty({ enum: Language })
  language!: Language;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why the run failed: WORLD_ANALYSIS_MISSING, DRAFT_DATA_INVALID, DRAFT_INPUT_MISSING, DRAFT_CANCELLED',
  })
  failedReason!: string | null;

  @ApiProperty({ enum: ['dossier', 'glossary'], nullable: true })
  waitingFor!: 'dossier' | 'glossary' | null;

  @ApiProperty({ type: LlmOperationDto })
  operation!: LlmOperationDto;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Steps of the run: 1 + 2 per character + 1 per pair + 1 per place + 1 per object + 1 per term + 1 per event (F08-13b-2); null - the characters are not chosen yet',
  })
  stepsTotal!: number | null;

  @ApiProperty({ type: [WorldWriteCandidateDto], nullable: true })
  candidates!: WorldWriteCandidateDto[] | null;

  @ApiProperty({
    type: [WorldWritePairDto],
    nullable: true,
    description:
      'Pairs of the run (F08-8e), their steps go after the steps of the characters; null - the characters are not chosen yet; [] for a run started before F08-8e',
  })
  pairs!: WorldWritePairDto[] | null;

  @ApiProperty({
    type: [WorldWriteSkipDto],
    description:
      'Characters, pairs, places, objects, terms, events and organizations the choice step left out, with the reason',
  })
  leftOut!: WorldWriteSkipDto[];

  @ApiProperty({
    enum: WORLD_PAIRS_OFF_REASONS,
    nullable: true,
    description: 'The run writes no pairs: WORLD_PAIR_LANGUAGE - no pair sample for the language',
  })
  pairsOff!: WorldPairsOffReason | null;

  @ApiProperty({
    type: [WorldWritePlaceDto],
    nullable: true,
    description:
      'Places of the run (F08-12b), their steps go after the steps of the pairs; null - not chosen yet; [] for a run started before F08-12b',
  })
  places!: WorldWritePlaceDto[] | null;

  @ApiProperty({
    enum: WORLD_PLACES_OFF_REASONS,
    nullable: true,
    description:
      'The run writes no places: WORLD_PLACE_LANGUAGE - no place sample for the language',
  })
  placesOff!: WorldPlacesOffReason | null;

  @ApiProperty({
    type: [WorldWritePlaceDto],
    nullable: true,
    description:
      'Objects of the run (F08-13b), their steps go after the steps of the places; null - not chosen yet; [] for a run started before F08-13b',
  })
  objects!: WorldWritePlaceDto[] | null;

  @ApiProperty({
    type: [WorldWritePlaceDto],
    nullable: true,
    description:
      'Terms of the run (F08-13b), their steps go after the steps of the objects; null - not chosen yet; [] for a run started before F08-13b',
  })
  terms!: WorldWritePlaceDto[] | null;

  @ApiProperty({
    enum: WORLD_OBJECTS_OFF_REASONS,
    nullable: true,
    description:
      'The run writes no objects: WORLD_OBJECT_LANGUAGE - no object sample for the language',
  })
  objectsOff!: WorldObjectsOffReason | null;

  @ApiProperty({
    enum: WORLD_TERMS_OFF_REASONS,
    nullable: true,
    description: 'The run writes no terms: WORLD_TERM_LANGUAGE - no term sample for the language',
  })
  termsOff!: WorldTermsOffReason | null;

  @ApiProperty({
    type: [WorldWritePlaceDto],
    nullable: true,
    description:
      'Events of the run (F08-13b-2), their steps go after the steps of the terms; named by the choice step, the key is built by the code; null - not chosen yet; [] for a run started before F08-13b-2',
  })
  events!: WorldWritePlaceDto[] | null;

  @ApiProperty({
    enum: WORLD_EVENTS_OFF_REASONS,
    nullable: true,
    description:
      'The run writes no events: WORLD_EVENT_LANGUAGE - no event sample for the language',
  })
  eventsOff!: WorldEventsOffReason | null;

  @ApiProperty({ type: [WorldWriteStepDto] })
  steps!: WorldWriteStepDto[];

  @ApiProperty({ type: [WorldWriteItemDto] })
  items!: WorldWriteItemDto[];

  @ApiProperty({ type: [WorldWriteDroppedQuoteDto] })
  droppedQuotes!: WorldWriteDroppedQuoteDto[];

  @ApiProperty({ type: [WorldWriteDroppedSourceDto] })
  droppedSources!: WorldWriteDroppedSourceDto[];

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}

export class WorldAcceptAllSkippedDto {
  @ApiProperty({ type: Number })
  index!: number;

  @ApiProperty({ enum: WORLD_ACCEPT_ALL_SKIP_CODES })
  code!: WorldAcceptAllSkipCode;
}

export class WorldAcceptAllDto extends WorldWriteDto {
  @ApiProperty({
    type: [WorldAcceptAllSkippedDto],
    description: 'Proposals left as proposals by their own refusal, with its code',
  })
  skipped!: WorldAcceptAllSkippedDto[];
}

export class WorldWriteStateDto {
  @ApiProperty({ type: WorldWriteDto, nullable: true })
  draft!: WorldWriteDto | null;
}

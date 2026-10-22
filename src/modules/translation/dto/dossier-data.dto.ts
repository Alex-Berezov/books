import { ApiProperty } from '@nestjs/swagger';

/**
 * Формат досье v1 и глоссария в Swagger - зеркало `dossier/dossier.format.ts`. Response DTO —
 * только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7): форму ответа модели проверяет
 * `shapeErrors` до записи.
 */

export class DossierAddressDto {
  @ApiProperty({ type: String }) to!: string;
  @ApiProperty({ type: String }) form!: string;
}

export class DossierRelationDto {
  @ApiProperty({ type: String }) to!: string;
  @ApiProperty({ type: String }) label!: string;
}

export class DossierCharacterDto {
  @ApiProperty({ type: String }) key!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: [String] }) variants!: string[];
  @ApiProperty({ type: String }) gender!: string;
  @ApiProperty({ type: String }) whoIs!: string;
  @ApiProperty({ type: [DossierAddressDto] }) address!: DossierAddressDto[];
  @ApiProperty({ type: [DossierRelationDto] }) relations!: DossierRelationDto[];
  @ApiProperty({ type: Number }) firstChapter!: number;
  @ApiProperty({ type: String }) fate!: string;
  @ApiProperty({ enum: ['main', 'secondary', 'episodic'] }) role!:
    | 'main'
    | 'secondary'
    | 'episodic';
}

export class DossierEntityDto {
  @ApiProperty({ type: String }) key!: string;
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ enum: ['place', 'object', 'organization', 'term'] })
  kind!: 'place' | 'object' | 'organization' | 'term';
  @ApiProperty({ type: String }) whatIs!: string;
  @ApiProperty({ type: Number }) firstChapter!: number;
}

export class DossierNarrationDto {
  @ApiProperty({ type: String }) person!: string;
  @ApiProperty({ type: String }) form!: string;
  @ApiProperty({ type: String }) notes!: string;
}

export class DossierSettingDto {
  @ApiProperty({ type: String }) place!: string;
  @ApiProperty({ type: String }) time!: string;
}

export class DossierStructurePartDto {
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: [Number], description: 'Reader chapter numbers' }) chapters!: number[];
}

export class DossierStructureDto {
  @ApiProperty({ type: [DossierStructurePartDto] }) parts!: DossierStructurePartDto[];
  @ApiProperty({ type: String }) notes!: string;
}

export class DossierChronologyDto {
  @ApiProperty({ type: String }) event!: string;
  @ApiProperty({ type: Number }) chapter!: number;
  @ApiProperty({ type: String }) orderNote!: string;
}

export class DossierChapterDto {
  @ApiProperty({ type: Number }) number!: number;
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: String }) summary!: string;
}

export class DossierSummarySectionDto {
  @ApiProperty({ type: Number }) number!: number;
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: [Number], description: 'Reader chapter numbers' }) chapters!: number[];
  @ApiProperty({ type: String }) why!: string;
}

export class DossierDeviceDto {
  @ApiProperty({ type: String }) name!: string;
  @ApiProperty({ type: String }) howShown!: string;
  @ApiProperty({ type: String }) example!: string;
  @ApiProperty({ type: Number }) chapter!: number;
}

export class DossierVoiceDto {
  @ApiProperty({ type: String }) pace!: string;
  @ApiProperty({ type: String }) sentenceLength!: string;
  @ApiProperty({ type: String }) lexicon!: string;
  @ApiProperty({ type: String }) irony!: string;
  @ApiProperty({ type: [DossierDeviceDto] }) devices!: DossierDeviceDto[];
}

export class DossierMotifDto {
  @ApiProperty({ type: String }) image!: string;
  @ApiProperty({ type: [Number], description: 'Reader chapter numbers' }) chapters!: number[];
}

export class DossierDataDto {
  @ApiProperty({ type: [DossierCharacterDto] }) characters!: DossierCharacterDto[];
  @ApiProperty({ type: [DossierEntityDto] }) entities!: DossierEntityDto[];
  @ApiProperty({ type: DossierNarrationDto }) narration!: DossierNarrationDto;
  @ApiProperty({ type: DossierSettingDto }) setting!: DossierSettingDto;
  @ApiProperty({ type: DossierStructureDto }) structure!: DossierStructureDto;
  @ApiProperty({ type: [DossierChronologyDto] }) chronology!: DossierChronologyDto[];
  @ApiProperty({ type: [DossierChapterDto] }) chapters!: DossierChapterDto[];
  @ApiProperty({ type: [DossierSummarySectionDto], description: 'Sections plan of the retelling' })
  summaryPlan!: DossierSummarySectionDto[];
  @ApiProperty({ type: DossierVoiceDto }) voice!: DossierVoiceDto;
  @ApiProperty({ type: [DossierMotifDto] }) motifs!: DossierMotifDto[];
}

export class GlossaryEntryDto {
  @ApiProperty({ type: String }) key!: string;
  @ApiProperty({ type: String }) source!: string;
  @ApiProperty({ type: String }) target!: string;
  @ApiProperty({ type: String }) kind!: string;
  @ApiProperty({ type: Boolean }) keepOriginal!: boolean;
  @ApiProperty({ type: String }) note!: string;
}

export class GlossaryAddressDto {
  @ApiProperty({ type: String }) from!: string;
  @ApiProperty({ type: String }) to!: string;
  @ApiProperty({ type: String }) form!: string;
}

export class GlossaryPhraseDto {
  @ApiProperty({ type: String }) source!: string;
  @ApiProperty({ type: String }) target!: string;
}

export class GlossaryDataDto {
  @ApiProperty({ type: [GlossaryEntryDto] }) entries!: GlossaryEntryDto[];
  @ApiProperty({ type: [GlossaryAddressDto] }) address!: GlossaryAddressDto[];
  @ApiProperty({ type: [GlossaryPhraseDto] }) phrases!: GlossaryPhraseDto[];
}

/** Дополнение глоссария по ходу перевода (`F05-4`): кусок-источник и новые записи. */
export class GlossaryHistoryItemDto {
  @ApiProperty({ type: String, nullable: true }) chunkId!: string | null;
  @ApiProperty({ type: [GlossaryEntryDto] }) entries!: GlossaryEntryDto[];
}

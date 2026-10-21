import { ApiProperty } from '@nestjs/swagger';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 *
 * Деньги - строкой с восемью знаками после точки (`"12.34567800"`), а не числом: решение
 * арбитра `F05 | F05-1`, В2 - сумма «до цента» не держится на float.
 */
const MONEY = {
  type: String,
  format: 'decimal',
  example: '100.00000000',
} as const;

export class LlmStatusResponseDto {
  @ApiProperty({
    enum: ['ENABLED', 'DISABLED'],
    description: 'DISABLED - OPENROUTER_API_KEY is not set or empty: nothing can call a model',
  })
  state!: 'ENABLED' | 'DISABLED';

  @ApiProperty({
    type: Boolean,
    description: 'Whether the key is configured; the key itself is never returned',
  })
  keyConfigured!: boolean;

  @ApiProperty({
    type: Boolean,
    description: 'Whether the single spending-ceiling row exists; without it every call is refused',
  })
  budgetConfigured!: boolean;

  @ApiProperty({ ...MONEY, nullable: true })
  ceilingUsd!: string | null;

  @ApiProperty({ ...MONEY, nullable: true, description: 'Spent in total, all operations' })
  spentUsd!: string | null;

  @ApiProperty({ ...MONEY, nullable: true, description: 'Reserved by calls in flight' })
  reservedUsd!: string | null;

  @ApiProperty({ ...MONEY, nullable: true, description: 'Default limit offered in the run dialog' })
  defaultRunLimitUsd!: string | null;
}

export class LlmBudgetResponseDto {
  @ApiProperty(MONEY)
  ceilingUsd!: string;

  @ApiProperty(MONEY)
  spentUsd!: string;

  @ApiProperty(MONEY)
  reservedUsd!: string;

  @ApiProperty(MONEY)
  defaultRunLimitUsd!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}

export class LlmModelDto {
  @ApiProperty({ type: String, example: 'anthropic/claude-sonnet-5.5' })
  id!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: Number, nullable: true })
  contextLength!: number | null;

  @ApiProperty({
    ...MONEY,
    nullable: true,
    description: 'USD per million input tokens; null - the model has no fixed price',
  })
  inputPerMTokUsd!: string | null;

  @ApiProperty({
    ...MONEY,
    nullable: true,
    description: 'USD per million output tokens; null - the model has no fixed price',
  })
  outputPerMTokUsd!: string | null;

  @ApiProperty({ type: Boolean, description: 'Accepts response_format with a JSON schema' })
  structuredOutputs!: boolean;
}

export class LlmStageSettingDto {
  @ApiProperty({ type: String })
  stage!: string;

  @ApiProperty({ type: String })
  model!: string;

  @ApiProperty({ type: [String], description: 'Fallback models in order' })
  fallbacks!: string[];

  @ApiProperty({ type: Number, nullable: true })
  temperature!: number | null;

  @ApiProperty({
    type: Number,
    description: 'Upper bound of the answer; the call reserve is priced by it',
  })
  maxTokens!: number;

  @ApiProperty({ type: Boolean })
  enabled!: boolean;

  @ApiProperty({
    ...MONEY,
    nullable: true,
    description: 'Price cap per million tokens; required for a model without a fixed price',
  })
  maxPricePerMTok!: string | null;

  @ApiProperty({
    enum: ['default', 'override'],
    description: 'default - code defaults; override - a row saved from the admin',
  })
  source!: 'default' | 'override';

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  updatedAt!: string | null;
}

import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RightsIntakeManifestService } from '../rights-intake/rights-intake-manifest.service';
import {
  RIGHTS_REPORT_SCHEMA_VERSIONS,
  RIGHTS_REPORT_JSON_SCHEMAS,
  LATEST_RIGHTS_REPORT_SCHEMA_VERSION,
  getReportSchemaDocument,
} from '../rights-intake/rights-review-schema.registry';
import { RightsAgentSubmissionService } from './rights-agent-submission.service';
import { RightsAgentTokenGuard, type AgentRequest } from './rights-agent-token.guard';
import { RightsAgentTokenService } from './rights-agent-token.service';
import { RightsAgentUploadRateLimitGuard } from './rights-agent-upload-rate-limit.guard';
import { AGENT_ERROR_CODES } from './rights-agent.constants';
import { agentError } from './rights-agent.errors';
import { AgentSubmitReportDto } from './dto/agent-submit-report.dto';
import type { RightsAgentManifestDto } from '../rights-intake/dto/rights-agent-manifest.dto';
import type { RightsReportSchemaDocument } from '../rights-intake/rights-review-schema.registry';
import type { AgentSubmitResponseDto } from './dto/agent-submit-response.dto';

/** Request shape with the fields the controller reads for auditing. */
interface AgentHttpRequest extends AgentRequest {
  ip?: string;
  socket?: { remoteAddress?: string };
}

/**
 * Public endpoints for the external clearance agent. Authentication is by one-time upload
 * token only — no JWT, no admin data, and nothing here can approve a review.
 */
@ApiTags('rights-agent')
@Controller('rights/agent')
export class RightsAgentController {
  constructor(
    private readonly submissions: RightsAgentSubmissionService,
    private readonly tokens: RightsAgentTokenService,
    private readonly manifests: RightsIntakeManifestService,
  ) {}

  @Get('report-schema')
  @Header('Cache-Control', 'public, max-age=3600')
  @ApiOperation({ summary: 'JSON Schema of the latest supported report version' })
  getLatestSchema(): RightsReportSchemaDocument {
    return RIGHTS_REPORT_JSON_SCHEMAS[LATEST_RIGHTS_REPORT_SCHEMA_VERSION];
  }

  @Get('report-schema/:version')
  @Header('Cache-Control', 'public, max-age=3600')
  @ApiOperation({ summary: 'JSON Schema of a specific report version' })
  getSchemaByVersion(@Param('version') version: string): RightsReportSchemaDocument {
    const document = getReportSchemaDocument(version);
    if (!document) {
      throw agentError(HttpStatus.NOT_FOUND, AGENT_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION, {
        requestedVersion: version,
        supportedVersions: [...RIGHTS_REPORT_SCHEMA_VERSIONS],
      });
    }
    return document;
  }

  @Get('manifest')
  @UseGuards(RightsAgentUploadRateLimitGuard, RightsAgentTokenGuard)
  @ApiOperation({ summary: 'Manifest of the intake bound to the upload token' })
  async getManifest(@Req() req: AgentHttpRequest): Promise<RightsAgentManifestDto> {
    const context = this.requireContext(req);
    // Reading the manifest records usage metadata but does not consume the token.
    await this.tokens.touchUsage(context.tokenId, this.resolveIp(req), this.resolveUserAgent(req));
    return this.manifests.generate(context.rightsIntakeId);
  }

  @Post('submissions')
  // 200, not Nest's default 201: the documented agent contract is "a submission always
  // answers 200, even when validation fails" — the agent distinguishes outcomes by the
  // `status` field, and 2xx-vs-4xx tells it whether the report was accepted at all.
  @HttpCode(HttpStatus.OK)
  @UseGuards(RightsAgentUploadRateLimitGuard, RightsAgentTokenGuard)
  @ApiOperation({ summary: 'Submit a clearance report. Never auto-approves.' })
  async submit(
    @Req() req: AgentHttpRequest,
    @Body() dto: AgentSubmitReportDto,
  ): Promise<AgentSubmitResponseDto> {
    const context = this.requireContext(req);
    return this.submissions.submit(context, dto, {
      ip: this.resolveIp(req),
      userAgent: this.resolveUserAgent(req),
    });
  }

  private requireContext(req: AgentHttpRequest) {
    const context = req.agentToken;
    if (!context) {
      throw agentError(HttpStatus.UNAUTHORIZED, AGENT_ERROR_CODES.AGENT_TOKEN_MISSING);
    }
    return context;
  }

  private resolveIp(req: AgentHttpRequest): string | null {
    return req.ip ?? req.socket?.remoteAddress ?? null;
  }

  private resolveUserAgent(req: AgentHttpRequest): string | null {
    const value = req.headers['user-agent'];
    const userAgent = Array.isArray(value) ? value[0] : value;
    return typeof userAgent === 'string' ? userAgent.slice(0, 500) : null;
  }
}

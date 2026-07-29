import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RightsAgentSubmissionService } from './rights-agent-submission.service';
import { RightsAgentTokenService } from './rights-agent-token.service';
import { CreateAgentTokenDto } from './dto/create-agent-token.dto';
import { ListAgentSubmissionsDto } from './dto/list-agent-submissions.dto';
import { ListAgentTokensDto } from './dto/list-agent-tokens.dto';
import { RevokeAgentTokenDto } from './dto/revoke-agent-token.dto';
import type {
  AgentSubmissionDto,
  AgentSubmissionListResponseDto,
} from './dto/agent-submission-response.dto';
import type {
  AgentTokenDto,
  AgentTokenIssuedDto,
  AgentTokenListResponseDto,
} from './dto/agent-token-response.dto';

@ApiTags('rights-agent-admin')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin, Role.ContentManager)
@ApiBearerAuth()
export class RightsAgentAdminController {
  constructor(
    private readonly tokens: RightsAgentTokenService,
    private readonly submissions: RightsAgentSubmissionService,
  ) {}

  @Post('admin/rights/intakes/:id/agent-tokens')
  @ApiOperation({
    summary: 'Issue a one-time upload token. The raw token is returned only here.',
  })
  issueToken(
    @Param('id') id: string,
    @Body() dto: CreateAgentTokenDto,
    @Req() req: { user: { userId: string } },
  ): Promise<AgentTokenIssuedDto> {
    return this.tokens.issue(id, dto, req.user.userId);
  }

  @Get('admin/rights/intakes/:id/agent-tokens')
  @ApiOperation({ summary: 'List upload tokens of an intake' })
  listTokens(
    @Param('id') id: string,
    @Query() query: ListAgentTokensDto,
  ): Promise<AgentTokenListResponseDto> {
    return this.tokens.listByIntake(id, query);
  }

  @Post('admin/rights/agent-tokens/:tokenId/revoke')
  @ApiOperation({ summary: 'Revoke an upload token' })
  revokeToken(
    @Param('tokenId') tokenId: string,
    @Body() dto: RevokeAgentTokenDto,
    @Req() req: { user: { userId: string } },
  ): Promise<AgentTokenDto> {
    return this.tokens.revoke(tokenId, dto, req.user.userId);
  }

  @Get('admin/rights/intakes/:id/agent-submissions')
  @ApiOperation({ summary: 'Agent submission history of an intake' })
  listIntakeSubmissions(
    @Param('id') id: string,
    @Query() query: ListAgentSubmissionsDto,
  ): Promise<AgentSubmissionListResponseDto> {
    return this.submissions.listByIntake(id, query);
  }

  @Get('admin/rights/agent-submissions')
  @ApiOperation({ summary: 'Global agent submission log' })
  listSubmissions(
    @Query() query: ListAgentSubmissionsDto,
  ): Promise<AgentSubmissionListResponseDto> {
    return this.submissions.listAll(query);
  }

  @Get('admin/rights/agent-submissions/:submissionId')
  @ApiOperation({ summary: 'Agent submission details' })
  getSubmission(@Param('submissionId') submissionId: string): Promise<AgentSubmissionDto> {
    return this.submissions.getById(submissionId);
  }
}

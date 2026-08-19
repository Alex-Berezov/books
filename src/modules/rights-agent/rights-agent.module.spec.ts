import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { RightsAgentModule } from './rights-agent.module';
import { RightsAgentSubmissionService } from './rights-agent-submission.service';
import { RightsAgentTokenGuard } from './rights-agent-token.guard';
import { RightsAgentTokenService } from './rights-agent-token.service';
import { RightsAgentUploadRateLimitGuard } from './rights-agent-upload-rate-limit.guard';
import { RightsNotificationsService } from './rights-notifications.service';
import type { TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../../shared/prisma/prisma.module';

/**
 * Dependency-injection smoke test.
 *
 * The other specs instantiate services with `new`, so they cannot catch a missing module
 * import — that only shows up when Nest builds the container. `RateLimitModule` is not
 * global, and forgetting to import it broke every e2e suite at bootstrap. Compiling the
 * module here keeps that class of failure in the fast unit run.
 *
 * `compile()` does not run lifecycle hooks, so `PrismaService.onModuleInit()` never fires
 * and no database connection is opened.
 */
describe('RightsAgentModule (DI)', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        RightsAgentModule,
      ],
    }).compile();
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it.each([
    ['RightsAgentTokenService', RightsAgentTokenService],
    ['RightsAgentSubmissionService', RightsAgentSubmissionService],
    ['RightsNotificationsService', RightsNotificationsService],
    ['RightsAgentTokenGuard', RightsAgentTokenGuard],
    ['RightsAgentUploadRateLimitGuard', RightsAgentUploadRateLimitGuard],
  ])('resolves %s', (_name, token) => {
    expect(moduleRef.get(token)).toBeDefined();
  });
});

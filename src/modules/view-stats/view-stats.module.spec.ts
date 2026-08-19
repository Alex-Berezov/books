import { describeDiSmoke } from '../../common/testing/di-smoke';
import { ViewStatsModule } from './view-stats.module';
import { PrismaModule } from '../../shared/prisma/prisma.module';

describeDiSmoke('ViewStatsModule', () => [PrismaModule, ViewStatsModule]);

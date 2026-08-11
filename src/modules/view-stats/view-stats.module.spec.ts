import { describeDiSmoke } from '../../common/testing/di-smoke';
import { ViewStatsModule } from './view-stats.module';

describeDiSmoke('ViewStatsModule', () => [ViewStatsModule]);

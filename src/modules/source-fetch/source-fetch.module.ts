import { Module } from '@nestjs/common';
import { SourceFetcherService } from './source-fetcher.service';

/**
 * Единственный путь исходящих запросов к адресам из ответа модели: другой код в бэкенде
 * к таким адресам напрямую не ходит. `SOURCE_FETCH_TEST_HOOKS` здесь не объявлен намеренно -
 * в боевой сборке обходных путей нет, токен подставляет только тест.
 */
@Module({
  providers: [SourceFetcherService],
  exports: [SourceFetcherService],
})
export class SourceFetchModule {}

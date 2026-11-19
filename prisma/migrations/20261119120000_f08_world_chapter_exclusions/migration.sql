-- F08-8a: исключённые главы у формы имени (тёзки). Добавочная: столбец без NOT NULL и без переноса данных;
-- NULL ничего не меняет в подсчёте, очередь пересчёта не ставится.
ALTER TABLE "BookWorldEntity" ADD COLUMN IF NOT EXISTS "aliasChapterExclusions" JSONB;

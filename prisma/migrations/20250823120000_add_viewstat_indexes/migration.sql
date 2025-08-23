-- Add indexes for ViewStat aggregations
CREATE INDEX IF NOT EXISTS "ViewStat_bookVersionId_timestamp_idx"
  ON "ViewStat" ("bookVersionId", "timestamp");

CREATE INDEX IF NOT EXISTS "ViewStat_userId_idx"
  ON "ViewStat" ("userId");

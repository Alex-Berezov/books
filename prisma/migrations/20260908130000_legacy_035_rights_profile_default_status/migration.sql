-- LEGACY-035: RightsProfile.status default never fired — every site that creates a
-- profile sets status explicitly: rights-materialization.service.ts:499 (the only
-- one in production), prisma/seed.ts:172, test/helpers/book-with-rights.ts:63 and
-- test/book-version-publish-gate.e2e-spec.ts:394. Aligning DEFAULT with the value
-- the old image actually writes; this does not touch existing rows and does not
-- change what the old image can read or write, so it is not a backwards-incompatible
-- change under ADR-018.
ALTER TABLE "RightsProfile" ALTER COLUMN "status" SET DEFAULT 'HUMAN_REVIEW_REQUIRED';

-- F05-7 (/fix В2): сумма, которой лимиту запуска не хватило на досье или глоссарий до трат.
-- Каждый оператор переживает повторный накат (ADR-018).
ALTER TABLE "TranslationRunLanguage" ADD COLUMN IF NOT EXISTS "reasonUsd" DECIMAL(14,8);

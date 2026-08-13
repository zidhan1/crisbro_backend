-- Repair any legacy invalid balance before enforcing the invariant. Preserve
-- available points by raising total when necessary; never discard a debit or
-- admin correction silently.
UPDATE "CustomerPoint"
SET
  "available_point" = GREATEST("available_point", 0),
  "total_point" = GREATEST("total_point", "available_point", 0);

-- A partial/invalid POS baseline cannot be used safely for delta rebasing.
-- Reset only the baseline; the effective balance remains untouched and the
-- next valid snapshot will establish a fresh baseline without overwriting it.
UPDATE "CustomerPoint"
SET
  "runchise_total_point" = NULL,
  "runchise_available_point" = NULL
WHERE ("runchise_total_point" IS NULL) <> ("runchise_available_point" IS NULL)
   OR "runchise_total_point" < 0
   OR "runchise_available_point" < 0
   OR "runchise_available_point" > "runchise_total_point";

ALTER TABLE "CustomerPoint"
  ADD CONSTRAINT "customer_point_total_nonnegative"
    CHECK ("total_point" >= 0),
  ADD CONSTRAINT "customer_point_available_nonnegative"
    CHECK ("available_point" >= 0),
  ADD CONSTRAINT "customer_point_available_lte_total"
    CHECK ("available_point" <= "total_point"),
  ADD CONSTRAINT "customer_point_runchise_total_nonnegative"
    CHECK ("runchise_total_point" IS NULL OR "runchise_total_point" >= 0),
  ADD CONSTRAINT "customer_point_runchise_available_nonnegative"
    CHECK ("runchise_available_point" IS NULL OR "runchise_available_point" >= 0),
  ADD CONSTRAINT "customer_point_runchise_pair_valid"
    CHECK (
      ("runchise_total_point" IS NULL AND "runchise_available_point" IS NULL)
      OR (
        "runchise_total_point" IS NOT NULL
        AND "runchise_available_point" IS NOT NULL
        AND "runchise_available_point" <= "runchise_total_point"
      )
    );

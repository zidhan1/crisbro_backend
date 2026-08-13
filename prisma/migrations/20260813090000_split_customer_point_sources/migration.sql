-- Keep the last imported POS snapshot separate from the effective balance.
-- NULL is intentional for existing rows: the first sync establishes the
-- baseline without erasing local adjustments/redemptions made before deploy.
ALTER TABLE "CustomerPoint"
  ADD COLUMN "runchise_total_point" INTEGER,
  ADD COLUMN "runchise_available_point" INTEGER;

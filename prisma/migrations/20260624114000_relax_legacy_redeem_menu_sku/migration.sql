-- Older databases may contain a legacy required sku column.
-- Fresh databases do not have this column.
DO $$
BEGIN
    IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
        AND table_name = 'RedeemMenuItem'
        AND column_name = 'sku'
    ) THEN
    ALTER TABLE "RedeemMenuItem"
        ALTER COLUMN "sku" DROP NOT NULL;
    END IF;
END $$;
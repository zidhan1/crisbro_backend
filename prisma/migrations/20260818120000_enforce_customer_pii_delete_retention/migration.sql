-- Enforce the retention policy at the database boundary as well as in the
-- application. This covers deletes performed by maintenance scripts or future
-- code paths and runs before ON DELETE SET NULL removes the customer_id link.
CREATE OR REPLACE FUNCTION anonymize_deleted_customer_snapshots()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "CustomerSalesTransactionReport"
  SET
    "nama_pelanggan" = NULL,
    "no_telepon" = NULL,
    "raw" = NULL
  WHERE "customer_id" = OLD."id"
     OR (
       OLD."runchise_id" IS NOT NULL
       AND "runchise_customer_id" = OLD."runchise_id"
     );

  UPDATE "RunchisePosRewardRedemption"
  SET
    "customer_name" = NULL,
    "customer_phone_number" = NULL,
    "raw" = NULL
  WHERE "customer_id" = OLD."id"
     OR (
       OLD."runchise_id" IS NOT NULL
       AND "runchise_customer_id" = OLD."runchise_id"
     );

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS "Customer_anonymize_snapshots_before_delete" ON "Customer";
CREATE TRIGGER "Customer_anonymize_snapshots_before_delete"
BEFORE DELETE ON "Customer"
FOR EACH ROW
EXECUTE FUNCTION anonymize_deleted_customer_snapshots();

-- Hapus snapshot yang tersimpan di source location yang tidak berlaku bagi customer.
-- location_ids eksplisit menjadi acuan utama; owner_location_id hanya menjadi fallback
-- ketika location_ids kosong atau bukan array.
DELETE FROM "RunchiseLocationCustomer"
WHERE CASE
  WHEN jsonb_typeof("location_ids") = 'array'
       AND jsonb_array_length("location_ids") > 0
    THEN NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text("location_ids") AS location_id(value)
      WHERE location_id.value ~ '^[0-9]+$'
        AND location_id.value::int = "source_location_id"
    )
  WHEN "owner_location_id" IS NOT NULL
    THEN "source_location_id" <> "owner_location_id"
  ELSE TRUE
END;

-- Setelah snapshot yang salah dibuang, normalisasi lokasi kosong ke owner location.
UPDATE "RunchiseLocationCustomer"
SET "location_ids" = jsonb_build_array("owner_location_id")
WHERE "owner_location_id" IS NOT NULL
  AND (
    jsonb_typeof("location_ids") <> 'array'
    OR jsonb_array_length("location_ids") = 0
  );

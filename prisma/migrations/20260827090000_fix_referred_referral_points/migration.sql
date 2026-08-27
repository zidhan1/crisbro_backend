-- Referral records represent a referral-code usage by the referred user.
-- Store the referred user's point_given value on the canonical usage row.
UPDATE "Referral" AS r
SET "point_awarded" = rp."point_given"
FROM "ReferralProgram" AS rp
WHERE r."referral_program_id" = rp."referral_id"
  AND r."referrer_id" = rp."owner_referral"
  AND r."point_awarded" IS DISTINCT FROM rp."point_given";

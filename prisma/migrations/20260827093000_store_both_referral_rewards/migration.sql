-- Store both sides of a referral reward on the referral usage record.
ALTER TABLE "Referral" ADD COLUMN "point_reward" INTEGER;

UPDATE "Referral" AS r
SET "point_reward" = rp."point_reward"
FROM "ReferralProgram" AS rp
WHERE r."referral_program_id" = rp."referral_id";

ALTER TABLE "Referral" ALTER COLUMN "point_reward" SET NOT NULL;

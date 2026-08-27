-- Revert the duplicated reward snapshot. The referral owner's reward remains
-- sourced from ReferralProgram.point_reward.
ALTER TABLE "Referral" DROP COLUMN "point_reward";

const { z } = require("zod");

const CreateReferralProgramSchema = z.object({
  owner_referral: z.string("Owner referral is required"),
  point_reward: z.number("Please give point reward for owner referral"),
  point_given: z.number("Please give point for who used referral"),
  expires_at: z.date(),
});

module.exports = { CreateReferralProgramSchema };

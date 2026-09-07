const {
  generateLoyaltyProducts,
  generatePromoCode,
} = require("./src/services/runchise.service");

const result = generatePromoCode({ runchise_promo_id: 58064, total_code: 10 });

console.log(result);

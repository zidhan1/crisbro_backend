const { createPromo } = require("./runchise.service");

async function createPromoService(payload) {
  const promo = await createPromo(payload);

  if (!promo) {
    throw new Error("Promo tidak berhasil dibuat di Runchise");
  }

  // NEXT: Simpan promo ke database lokal jika perlu
  return promo;
}

module.exports = { createPromoService };

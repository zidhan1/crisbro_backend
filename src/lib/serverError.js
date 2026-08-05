const crypto = require('crypto');

// Balasan seragam untuk kegagalan tak terduga (HTTP 500).
//
// Sebelumnya banyak handler mengembalikan `error.message` mentah ke client.
// Pesan itu berasal dari Prisma/Postgres dan kerap memuat nama tabel, nama
// kolom, dan nama constraint — peta struktur database yang tidak perlu
// diketahui siapa pun di luar tim.
//
// Detail aslinya tetap dibutuhkan untuk menelusuri masalah, jadi tidak dibuang:
// error lengkap ditulis ke log server bersama satu kode acak, dan kode itulah
// yang diberikan ke pengguna. Dengan begitu laporan "error kode a1b2c3d4"
// bisa langsung dicocokkan dengan barisnya di log tanpa membocorkan apa pun.
const GENERIC_MESSAGE =
  'Terjadi kesalahan pada server. Sebutkan kode error berikut bila menghubungi admin.';

function respondWithServerError(res, error, context = 'Unhandled error') {
  const errorId = crypto.randomBytes(4).toString('hex');

  console.error(`[error:${errorId}] ${context}:`, error);

  return res.status(500).json({
    message: GENERIC_MESSAGE,
    error_id: errorId,
  });
}

module.exports = { respondWithServerError, GENERIC_MESSAGE };

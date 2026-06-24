// Mengambil nilai JWT_SECRET dari environment variable
function getJwtSecret() {
  const secret = process.env.JWT_SECRET;

  // Memastikan JWT_SECRET sudah dikonfigurasi
  if (!secret) {
    const error = new Error('JWT_SECRET is not configured');
    error.code = 'JWT_SECRET_MISSING';
    throw error;
  }

  // Mengembalikan JWT_SECRET untuk digunakan dalam autentikasi JWT
  return secret;
}

// Mengekspor fungsi agar dapat digunakan di file lain
module.exports = getJwtSecret;

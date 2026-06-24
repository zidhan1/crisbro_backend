// Mengimpor library JWT dan fungsi untuk mengambil JWT_SECRET
const jwt = require('jsonwebtoken');
const getJwtSecret = require('../lib/jwtSecret');

// Middleware untuk memverifikasi token JWT pada setiap request
module.exports = (req, res, next) => {
  const header = req.headers.authorization;

  // Jika header tidak ada, akses ditolak
  if (!header) {
    return res.status(401).json({
      message: 'Unauthorized',
    });
  }

  // Mengambil token dari format "Bearer <token>"
  const token = header.split(' ')[1];

  // Jika token tidak ditemukan, akses ditolak
  if (!token) {
    return res.status(401).json({
      message: 'Unauthorized',
    });
  }

  try {
    // Memverifikasi token menggunakan JWT_SECRET
    const decoded = jwt.verify(token, getJwtSecret());

    // Menyimpan data hasil decode ke request agar dapat digunakan di controller
    req.user = decoded;
  } catch (error) {
    // Menangani jika JWT_SECRET belum dikonfigurasi
    if (error.code === 'JWT_SECRET_MISSING') {
      return res.status(500).json({
        message: 'Authentication configuration error',
      });
    }

    // Menangani jika token sudah kedaluwarsa
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        message: 'Token expired',
      });
    }

    // Menangani token yang tidak valid
    return res.status(401).json({
      message: 'Invalid or expired token',
    });
  }

  // Melanjutkan ke middleware atau controller berikutnya
  next();
};

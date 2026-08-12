// Mengimpor library JWT dan fungsi untuk mengambil JWT_SECRET
const jwt = require('jsonwebtoken');
const getJwtSecret = require('../lib/jwtSecret');
const prisma = require('../lib/prisma');
const { getSessionCookie, clearSessionCookie } = require('../lib/sessionCookie');
const { computeSlidingSessionExpiry } = require('../lib/sessionPolicy');

// Middleware untuk memverifikasi token JWT pada setiap request
module.exports = async (req, res, next) => {
  const header = req.headers.authorization;
  const bearerToken =
    typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice(7).trim()
      : null;
  const cookieToken = getSessionCookie(req);
  // Cookie diprioritaskan untuk browser; Bearer dipertahankan bagi tooling API.
  const token = cookieToken || bearerToken;

  // Jika token tidak ditemukan, akses ditolak
  if (!token) {
    return res.status(401).json({
      message: 'Unauthorized',
    });
  }

  try {
    // Memverifikasi token menggunakan JWT_SECRET
    const decoded = jwt.verify(token, getJwtSecret());

    const session = await prisma.session.findUnique({
      where: { token },
      select: { user_id: true, expires_at: true },
    });

    if (!session || session.user_id !== decoded.id || session.expires_at <= new Date()) {
      if (cookieToken) clearSessionCookie(res);
      return res.status(401).json({
        message: 'Session tidak valid atau sudah berakhir',
      });
    }

    // H-2: menggeser batas idle sesi selama user masih aktif. Batas absolut
    // (`decoded.exp`) tidak ikut bergeser, jadi sesi tetap punya umur maksimum
    // yang tegas. Penulisan di-throttle di `computeSlidingSessionExpiry` supaya
    // tidak menjadi satu UPDATE per request.
    const slidingExpiry = computeSlidingSessionExpiry({
      role: decoded.role,
      now: Date.now(),
      tokenExpMs: decoded.exp * 1000,
      currentExpiresAt: session.expires_at,
    });

    if (slidingExpiry) {
      try {
        await prisma.session.update({
          where: { token },
          data: { expires_at: slidingExpiry },
        });
      } catch (renewError) {
        // Perpanjangan bersifat best-effort. Sesi masih sah sampai
        // `expires_at` yang tersimpan, jadi kegagalan menulis tidak boleh
        // menggagalkan request yang sudah terautentikasi.
        console.error('Gagal memperbarui masa berlaku sesi:', renewError.message);
      }
    }

    // Menyimpan data hasil decode ke request agar dapat digunakan di controller
    req.user = decoded;
    // Dipakai handler logout untuk menghapus baris sesi milik token ini saja,
    // tanpa mengeluarkan perangkat lain milik user yang sama.
    req.sessionToken = token;
  } catch (error) {
    if (cookieToken) clearSessionCookie(res);
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

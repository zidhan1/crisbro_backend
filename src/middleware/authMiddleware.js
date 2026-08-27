// Mengimpor library JWT dan fungsi untuk mengambil JWT_SECRET
const jwt = require("jsonwebtoken");
const getJwtSecret = require("../lib/jwtSecret");
const prisma = require("../lib/prisma");
const {
  getSessionCookie,
  clearSessionCookie,
} = require("../lib/sessionCookie");

// Middleware untuk memverifikasi token JWT pada setiap request
const auth = async (req, res, next) => {
  const header = req.headers.authorization;
  const bearerToken =
    typeof header === "string" && header.startsWith("Bearer ")
      ? header.slice(7).trim()
      : null;
  const cookieToken = getSessionCookie(req);
  // Cookie diprioritaskan untuk browser; Bearer dipertahankan bagi tooling API.
  const token = cookieToken || bearerToken;

  // Jika token tidak ditemukan, akses ditolak
  if (!token) {
    return res.status(401).json({
      message: "Unauthorized",
    });
  }

  try {
    // Memverifikasi token menggunakan JWT_SECRET
    const decoded = jwt.verify(token, getJwtSecret());

    if (!decoded.user_id) {
      throw new jwt.JsonWebTokenError("Token tidak memiliki user_id");
    }

    // Model Session tidak ada pada schema aktif. Validasi user memastikan token
    // milik akun yang sudah dihapus tidak tetap diterima.
    const user = await prisma.user.findUnique({
      where: { user_id: decoded.user_id },
      select: { user_id: true, role: true },
    });

    if (!user) {
      if (cookieToken) clearSessionCookie(res);
      return res.status(401).json({ message: "User tidak ditemukan" });
    }

    // `id` dipertahankan sementara untuk controller lama; primary key schema
    // saat ini bernama `user_id`.
    req.user = { ...decoded, id: user.user_id, user_id: user.user_id };
  } catch (error) {
    if (cookieToken) clearSessionCookie(res);
    // Menangani jika JWT_SECRET belum dikonfigurasi
    if (error.code === "JWT_SECRET_MISSING") {
      return res.status(500).json({
        message: "Authentication configuration error",
      });
    }

    // Menangani jika token sudah kedaluwarsa
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        message: "Token expired",
      });
    }

    // Menangani token yang tidak valid
    return res.status(401).json({
      message: "Invalid or expired token",
    });
  }

  return next();
};

const requireValidPhone = async (req, res, next) => {
  const user_id = req.user.user_id ?? undefined;

  if (!user_id)
    return res.status(403).json({
      message: "Invalid User",
    });

  try {
    const user = await prisma.user.findUnique({ where: { user_id } });

    if (!user)
      return res.status(404).json({
        message: "User not found",
      });

    if (!user.phone_verified)
      return res.status(403).json({
        message: "Please validate your phone number",
      });

    return next();
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      message: "Unhandled error",
    });
  }
};

const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    // Memeriksa apakah user sudah login dan memiliki role yang diizinkan
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    // Melanjutkan ke middleware atau controller berikutnya jika role sesuai
    next();
  };
};

module.exports = { auth, requireValidPhone, requireRole };

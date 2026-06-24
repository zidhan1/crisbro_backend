// Middleware untuk membatasi akses berdasarkan role pengguna
module.exports = (...allowedRoles) => {
  return (req, res, next) => {
    // Memeriksa apakah user sudah login dan memiliki role yang diizinkan
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    // Melanjutkan ke middleware atau controller berikutnya jika role sesuai
    next();
  };
};

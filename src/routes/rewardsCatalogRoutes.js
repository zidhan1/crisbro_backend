// Mengimpor Express untuk membuat router
const express = require('express');
const router = express.Router();

// Middleware autentikasi JWT
const auth = require('../middleware/auth');

// Middleware otorisasi berdasarkan role (admin, staff, dll)
const requireRole = require('../middleware/requireRole');

// Mengimpor controller untuk katalog reward
const {
  getAll,
  getOne,
  create,
  update,
  remove,
} = require('../controllers/rewardsCatalogController');

// ===================== PUBLIC ROUTES =====================

// Ambil semua reward (bisa difilter brand & status)
router.get('/', getAll);

// Ambil detail reward berdasarkan ID
router.get('/:id', getOne);

// ===================== ADMIN / STAFF ONLY =====================

// Tambah reward baru (hanya admin/staff)
router.post('/', auth, requireRole('admin', 'staff'), create);

// Update reward (hanya admin/staff)
router.put('/:id', auth, requireRole('admin', 'staff'), update);

// Hapus reward (hanya admin/staff)
router.delete('/:id', auth, requireRole('admin', 'staff'), remove);

module.exports = router;

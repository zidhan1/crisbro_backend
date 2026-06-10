const express = require('express');
const router = express.Router();

const auth = require('../middleware/auth');
const {
  getAll,
  getOne,
  create,
  update,
  remove,
} = require('../controllers/rewardsCatalogController');

router.get('/', getAll);           // publik — bisa difilter ?brand_id=1&is_active=true
router.get('/:id', getOne);        // publik
router.post('/', auth, create);    // admin/staff only
router.put('/:id', auth, update);  // admin/staff only
router.delete('/:id', auth, remove); // admin/staff only

module.exports = router;
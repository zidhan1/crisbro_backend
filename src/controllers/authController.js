const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');

// ===================== REGISTER =====================
async function register(req, res) {
  try {
    // Ambil data nama juga dari body request untuk diisi ke tabel Customer
    const { email, phone_number, password, name } = req.body;

    if (!phone_number || !password || !name) {
      return res.status(400).json({
        message: 'Nama, nomor telepon, dan password wajib diisi',
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        phone_number,
        password_hash: hashedPassword,
        role: 'customer',
        customer: {
          create: {
            name: name,
            status: 'active',
            brand_id: 1, // Default ke brand id 1 (Crisbar) sesuai record DBML
            balance: 0,
            customer_point: {
              create: {
                total_point: 0,
                available_point: 0,
                next_reward_threshold: 2000,
              },
            },
          },
        },
      },
      // include ini supaya data customer yang baru dibuat langsung ikut ke-print di response
      include: {
        customer: true,
      },
    });

    const { password_hash, ...safeUser } = user;
    return res.status(201).json(safeUser);
  } catch (error) {
    if (error.code === 'P2002') {
      return res
        .status(400)
        .json({ message: 'Email atau nomor telepon sudah terdaftar' });
    }
    return res.status(500).json({ error: error.message });
  }
}

// ===================== LOGIN =====================
async function login(req, res) {
  try {
    const { phone_number, password } = req.body;

    // Tambahkan include agar data relasi customer-nya ikut terbawa
    const user = await prisma.user.findUnique({
      where: { phone_number },
      include: {
        // ← include harus di sini
        customer: {
          include: {
            customer_point: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ message: 'User tidak ditemukan' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ message: 'Password salah' });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role },
      process.env.JWT_SECRET || 'SECRET_KEY',
    );

    const { password_hash, ...safeUser } = user;

    res.json({
      token,
      user: safeUser,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ===================== PROFILE =====================
async function profile(req, res) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        // ← include harus di sini
        customer: {
          include: {
            customer_point: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ message: 'User tidak ditemukan' });
    }

    const { password_hash, ...safeUser } = user;
    res.json(safeUser);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

module.exports = {
  register,
  login,
  profile,
};

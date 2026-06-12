const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const { createCustomer } = require('../services/runchiseService');

// ===================== REGISTER =====================
async function register(req, res) {
  try {
    const { email, phone_number, password, name } = req.body;

    if (!phone_number || !password || !name) {
      return res.status(400).json({
        message: 'Nama, nomor telepon, dan password wajib diisi',
      });
    }

    // 1. Cek dulu apakah nomor telepon sudah terdaftar di DB lokal
    const existingUser = await prisma.user.findUnique({ where: { phone_number } });
    if (existingUser) {
      return res.status(400).json({ message: 'Nomor telepon sudah terdaftar' });
    }

    // 2. DAFTARKAN KE RUNCHISE TERLEBIH DAHULU
    // Catatan: Tentukan locationId default untuk registrasi, misalnya 4453 (Antapani) seperti di contohmu
    const defaultLocationId = 4453; 
    let runchiseId = null;

    try {
      const runchiseResponse = await createCustomer(defaultLocationId, {
        name,
        phone_number,
        email
      });
      
      // Ambil ID dari response Runchise (sesuaikan strukturnya dengan payload asli dari Runchise)
      // Biasanya berbentuk runchiseResponse.id atau runchiseResponse.customer.id
      runchiseId = runchiseResponse?.id || runchiseResponse?.customer?.id;
    } catch (apiError) {
      return res.status(424).json({ 
        message: 'Gagal sinkronisasi pendaftaran dengan sistem Runchise', 
        error: apiError.message 
      });
    }

    // 3. JIKA SUKSES DI RUNCHISE, SIMPAN KE DATABASE POSTGRESQL LOKAL
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
            brand_id: 1, // Sesuaikan dengan id brand lokalmu
            runchise_id: runchiseId, // <-- SEKARANG RUNCHISE_ID SUDAH TERSIMPAN!
            balance: 0,
            phone_number_country_code: 62,
            owner_location_id: null, // Hubungkan dengan ID lokasi lokalmu jika ada
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
      include: {
        customer: true,
      },
    });

    const { password_hash, ...safeUser } = user;
    return res.status(201).json(safeUser);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// ===================== LOGIN =====================
async function login(req, res) {
  try {
    const { phone_number, password } = req.body;

    // 1. Cari user di database lokal
    let user = await prisma.user.findUnique({
      where: { phone_number },
      include: {
        customer: {
          include: { customer_point: true },
        },
      },
    });

    // 2. JIKA USER TIDAK DITEMUKAN DI LOKAL, CEK DI RUNCHISE (Just In Time Provisioning)
    if (!user) {
      // Kamu bisa manfaatkan fungsi fetchAllCustomers dengan filter nomor HP (jika API Runchise mendukung)
      // Atau buat fungsi khusus search di runchiseService.
      // Jika ternyata user ada di Runchise namun belum ada password di lokal, 
      // arahkan user untuk melakukan registrasi/set password terlebih dahulu.
      return res.status(444).json({ 
        message: 'Nomor terdaftar di pusat, silahkan lakukan Registrasi untuk membuat password akun aplikasi ini.' 
      });
    }

    // 3. Verifikasi Password jika user lokal ada
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

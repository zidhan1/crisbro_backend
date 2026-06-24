// Mengimpor library untuk enkripsi password, JWT, database, dan layanan Runchise
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const getJwtSecret = require('../lib/jwtSecret');
const { findCustomerByPhone } = require('../services/runchiseService');

// Konfigurasi masa berlaku token login
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// Konfigurasi ID lokasi registrasi default Runchise
const RUNCHISE_REGISTRATION_LOCATION_ID =
  process.env.RUNCHISE_REGISTRATION_LOCATION_ID || 4453;

// Mengecek apakah user hasil sinkronisasi dan belum memiliki password
function isSyncedPlaceholderUser(user) {
  return user && user.password_hash === '';
}

// Mengubah nomor telepon menjadi format standar (8xxxxxxxx)
function normalizePhone(raw) {
  if (!raw) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('62')) return digits.slice(2);
  if (digits.startsWith('0')) return digits.slice(1);
  return digits;
}

// Membuat beberapa variasi nomor telepon untuk proses pencarian
function phoneVariants(normalizedPhone) {
  if (!normalizedPhone) return [];

  return Array.from(
    new Set([normalizedPhone, `0${normalizedPhone}`, `62${normalizedPhone}`]),
  );
}

// Mengubah data customer dari Runchise menjadi format database lokal
function mapRunchiseCustomerToLocalPayload(runchiseCustomer, fallback) {
  return {
    runchise_id: runchiseCustomer.id,
    name: runchiseCustomer.name || fallback.name,
    phone_number: fallback.phone_number,
    phone_number_country_code: runchiseCustomer.phone_number_country_code ?? 62,
    address: runchiseCustomer.address ?? null,
    province: runchiseCustomer.province ?? null,
    city: runchiseCustomer.city ?? null,
    country: runchiseCustomer.country ?? null,
    postal_code: runchiseCustomer.postal_code ?? null,
    dob:
      runchiseCustomer.dob && !isNaN(new Date(runchiseCustomer.dob))
        ? new Date(runchiseCustomer.dob)
        : null,
    gender: runchiseCustomer.gender ?? 'unknown',
    status: runchiseCustomer.status ?? 'active',
    balance: parseFloat(runchiseCustomer.balance ?? 0),
    brand_id: runchiseCustomer.brand_id ?? fallback.brand_id,
    owner_location_id: null,
  };
}

// ===================== REGISTER =====================
// Menangani proses registrasi customer
async function register(req, res) {
  try {
    const { email, password, name } = req.body;
    const phone_number = normalizePhone(req.body.phone_number);

    // Memvalidasi data registrasi
    if (!phone_number || !phone_number.startsWith('8') || !password || !name) {
      return res.status(400).json({
        message: 'Nama, nomor telepon (diawali 8), dan password wajib diisi',
      });
    }

    let runchiseCustomer;

    try {
      // Mengecek apakah customer sudah terdaftar di Runchise
      runchiseCustomer = await prisma.customer.findFirst({
        where: { phone_number },
      });
    } catch (apiError) {
      console.log(apiError);
      return res.status(424).json({
        message: 'Gagal memeriksa data customer ke sistem Runchise',
        error: apiError.message,
      });
    }

    // Jika customer belum ada di Runchise maka registrasi ditolak
    if (!runchiseCustomer) {
      return res.status(404).json({
        message:
          'Nomor telepon belum terdaftar di Runchise. Registrasi hanya untuk customer yang sudah terdaftar.',
      });
    }

    // Mencari user berdasarkan nomor telepon
    const existingUserByPhone = await prisma.user.findFirst({
      where: { phone_number: { in: phoneVariants(phone_number) } },
      include: {
        customer: {
          include: { customer_point: true },
        },
      },
    });

    // Mencari user berdasarkan ID Runchise
    const existingUserByRunchiseId = await prisma.user.findFirst({
      where: {
        customer: {
          runchise_id: runchiseCustomer.id,
        },
      },
      include: {
        customer: {
          include: { customer_point: true },
        },
      },
    });

    // Mengecek apakah akun sudah pernah melakukan registrasi
    const registeredExistingUser = [
      existingUserByPhone,
      existingUserByRunchiseId,
    ].find((user) => user && !isSyncedPlaceholderUser(user));

    if (registeredExistingUser) {
      return res.status(400).json({ message: 'Nomor telepon sudah terdaftar' });
    }

    const existingUser = existingUserByPhone || existingUserByRunchiseId;

    // Mengenkripsi password sebelum disimpan
    const hashedPassword = await bcrypt.hash(password, 10);

    // Menentukan brand customer
    const brandId =
      runchiseCustomer.brand_id ?? existingUser?.customer?.brand_id ?? 1;

    // Membuat data brand jika belum tersedia
    await prisma.brand.upsert({
      where: { id: brandId },
      update: {},
      create: { id: brandId, name: `Brand ${brandId}` },
    });

    // Jika user sudah ada, lakukan update data
    if (existingUser) {
      // Update user dan customer dalam satu transaksi database
      const user = await prisma.$transaction(async (tx) => {
        const customerPayload = mapRunchiseCustomerToLocalPayload(
          runchiseCustomer,
          { name, phone_number, brand_id: brandId },
        );

        const updatedUser = await tx.user.update({
          where: { id: existingUser.id },
          data: {
            email,
            phone_number,
            password_hash: hashedPassword,
            customer: existingUser.customer
              ? { update: customerPayload }
              : { create: customerPayload },
          },
          include: {
            customer: {
              include: { customer_point: true },
            },
          },
        });

        if (!updatedUser.customer.customer_point) {
          await tx.customerPoint.create({
            data: {
              customer_id: updatedUser.customer.id,
              total_point: runchiseCustomer.total_point ?? 0,
              available_point: runchiseCustomer.available_point ?? 0,
              next_reward_threshold: 2000,
            },
          });

          return tx.user.findUnique({
            where: { id: updatedUser.id },
            include: {
              customer: {
                include: { customer_point: true },
              },
            },
          });
        }

        return updatedUser;
      });

      // Menghapus password sebelum dikirim ke frontend
      const { password_hash, ...safeUser } = user;
      return res.status(200).json(safeUser);
    }

    // Jika user belum ada, buat akun baru
    const user = await prisma.user.create({
      data: {
        email,
        phone_number,
        password_hash: hashedPassword,
        role: 'customer',
        customer: {
          create: {
            ...mapRunchiseCustomerToLocalPayload(runchiseCustomer, {
              name,
              phone_number,
              brand_id: brandId,
            }),
            customer_point: {
              create: {
                total_point: runchiseCustomer.total_point ?? 0,
                available_point: runchiseCustomer.available_point ?? 0,
                next_reward_threshold: 2000,
              },
            },
          },
        },
      },
      include: {
        customer: {
          include: { customer_point: true },
        },
      },
    });

    // Menghapus password sebelum response
    const { password_hash, ...safeUser } = user;
    return res.status(201).json(safeUser);
  } catch (error) {
    // Menangani error yang tidak terduga
    return res.status(500).json({ error: error.message });
  }
}

// ===================== LOGIN =====================
// Menangani proses login user
async function login(req, res) {
  try {
    // Mengambil data login dari request
    const { password } = req.body;
    const phone_number = normalizePhone(req.body.phone_number);

    // Mencari user di database lokal
    let user = await prisma.user.findUnique({
      where: { phone_number },
      include: {
        customer: {
          include: { customer_point: true },
        },
      },
    });

    // Jika user belum ada di database lokal
    if (!user) {
      return res.status(444).json({
        message:
          'Nomor terdaftar di pusat, silahkan lakukan Registrasi untuk membuat password akun aplikasi ini.',
      });
    }

    // Jika akun hanya hasil sinkronisasi dan belum memiliki password
    if (isSyncedPlaceholderUser(user)) {
      return res.status(409).json({
        message:
          'Akun sudah terdaftar dari pusat, silahkan lakukan Registrasi untuk membuat password',
      });
    }

    // Memverifikasi password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ message: 'Password salah' });
    }

    // Membuat JWT Token untuk autentikasi
    const token = jwt.sign({ id: user.id, role: user.role }, getJwtSecret(), {
      expiresIn: JWT_EXPIRES_IN,
    });

    // Menghapus password sebelum dikirim ke frontend
    const { password_hash, ...safeUser } = user;

    // Mengirim token dan data user
    res.json({
      token,
      expiresIn: JWT_EXPIRES_IN,
      user: safeUser,
    });
  } catch (error) {
    // Menangani error konfigurasi JWT
    if (error.code === 'JWT_SECRET_MISSING') {
      return res.status(500).json({
        message: 'Authentication configuration error',
      });
    }

    // Menangani error lainnya
    res.status(500).json({ error: error.message });
  }
}

// ===================== PROFILE =====================
// Mengambil profil user yang sedang login
async function profile(req, res) {
  try {
    // Mengambil data user beserta customer dan poin
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        customer: {
          include: {
            customer_point: true,
          },
        },
      },
    });

    // Jika user tidak ditemukan
    if (!user) {
      return res.status(404).json({ message: 'User tidak ditemukan' });
    }

    // Menghapus password sebelum dikirim ke frontend
    const { password_hash, ...safeUser } = user;
    res.json(safeUser);
  } catch (error) {
    // Menangani error
    res.status(500).json({ error: error.message });
  }
}

// Mengekspor fungsi agar dapat digunakan oleh file route
module.exports = {
  register,
  login,
  profile,
};

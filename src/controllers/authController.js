// Mengimpor library untuk enkripsi password, JWT, database, dan layanan Runchise
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const getJwtSecret = require('../lib/jwtSecret');

// Konfigurasi masa berlaku token login
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

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

    const phoneNumberVariants = phoneVariants(phone_number);

    const syncedCustomer = await prisma.customer.findFirst({
      where: {
        phone_number: { in: phoneNumberVariants },
        runchise_id: { not: null },
      },
      include: {
        user: true,
        customer_point: true,
      },
    });

    // Jika customer belum tersinkron dari Runchise maka registrasi ditolak
    if (!syncedCustomer) {
      return res.status(404).json({
        message:
          'Nomor telepon belum terdaftar di data Runchise lokal. Silakan tunggu sinkronisasi data customer.',
      });
    }

    // Mencari user berdasarkan nomor telepon
    const existingUserByPhone = await prisma.user.findFirst({
      where: { phone_number: { in: phoneNumberVariants } },
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
          runchise_id: syncedCustomer.runchise_id,
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
      syncedCustomer.brand_id ?? existingUser?.customer?.brand_id ?? 1;

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
        const updatedUser = await tx.user.update({
          where: { id: existingUser.id },
          data: {
            email,
            phone_number,
            password_hash: hashedPassword,
            customer: existingUser.customer
              ? {
                  update: {
                    name,
                    phone_number,
                    status: 'active',
                  },
                }
              : {
                  create: {
                    runchise_id: syncedCustomer.runchise_id,
                    name,
                    phone_number,
                    phone_number_country_code:
                      syncedCustomer.phone_number_country_code,
                    address: syncedCustomer.address,
                    province: syncedCustomer.province,
                    city: syncedCustomer.city,
                    country: syncedCustomer.country,
                    postal_code: syncedCustomer.postal_code,
                    dob: syncedCustomer.dob,
                    gender: syncedCustomer.gender,
                    status: 'active',
                    balance: syncedCustomer.balance,
                    brand_id: brandId,
                    owner_location_id: syncedCustomer.owner_location_id,
                  },
                },
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
              total_point: syncedCustomer.customer_point?.total_point ?? 0,
              available_point:
                syncedCustomer.customer_point?.available_point ?? 0,
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
            runchise_id: syncedCustomer.runchise_id,
            name,
            phone_number,
            phone_number_country_code: syncedCustomer.phone_number_country_code,
            address: syncedCustomer.address,
            province: syncedCustomer.province,
            city: syncedCustomer.city,
            country: syncedCustomer.country,
            postal_code: syncedCustomer.postal_code,
            dob: syncedCustomer.dob,
            gender: syncedCustomer.gender,
            status: 'active',
            balance: syncedCustomer.balance,
            brand_id: brandId,
            owner_location_id: syncedCustomer.owner_location_id,
            customer_point: {
              create: {
                total_point: syncedCustomer.customer_point?.total_point ?? 0,
                available_point:
                  syncedCustomer.customer_point?.available_point ?? 0,
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

// Mengimpor library untuk enkripsi password, JWT, database, dan layanan Runchise
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const getJwtSecret = require('../lib/jwtSecret');
const {
  hashActivationToken,
} = require('../services/accountActivationService');

// Konfigurasi masa berlaku token login
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// Mengecek apakah user hasil sinkronisasi dan belum memiliki password
function isSyncedPlaceholderUser(user) {
  return (
    user &&
    (user.password_hash === '' || user.activation_status === 'pending_activation')
  );
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

function serializeAuthUser(user) {
  if (!user) return user;

  const { password_hash, ...safeUser } = user;
  const serializedUser = {
    ...safeUser,
  };

  if (serializedUser.email === null) {
    delete serializedUser.email;
  }

  if (serializedUser.phone_number === null) {
    delete serializedUser.phone_number;
  }

  if (!serializedUser.customer) {
    return serializedUser;
  }

  return {
    ...serializedUser,
    customer: {
      ...serializedUser.customer,
      balance: Number(serializedUser.customer.balance ?? 0),
    },
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
          'Nomor telepon belum terdaftar di data Runchise. Silakan hubungi Admin untuk melakukan pendaftaran.',
        whatsappUrl:
          'https://wa.me/6282121214145?text=Halo%20Admin,%20nomor%20telepon%20saya%20belum%20terdaftar%20di%20data%20Runchise.%20Mohon%20bantuannya.',
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
            activation_status: 'active',
            activated_at: new Date(),
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

      return res.status(200).json(serializeAuthUser(user));
    }

    // Jika user belum ada, buat akun baru
    const user = await prisma.user.create({
      data: {
        email,
        phone_number,
        password_hash: hashedPassword,
        activation_status: 'active',
        activated_at: new Date(),
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

    return res.status(201).json(serializeAuthUser(user));
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

    if (
      !phone_number ||
      !phone_number.startsWith('8') ||
      typeof password !== 'string' ||
      password.trim().length === 0
    ) {
      return res.status(400).json({
        message: 'Nomor telepon harus diawali 8 dan password wajib diisi',
      });
    }

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
          'Akun belum aktif. Silakan buka link aktivasi untuk membuat password.',
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
    const decodedToken = jwt.decode(token);
    const expiresAt =
      decodedToken && typeof decodedToken.exp === 'number'
        ? new Date(decodedToken.exp * 1000)
        : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.session.create({
      data: {
        user_id: user.id,
        token,
        expires_at: expiresAt,
      },
    });

    // Mengirim token dan data user
    res.json({
      token,
      expiresIn: JWT_EXPIRES_IN,
      user: serializeAuthUser(user),
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

// ===================== ACTIVATION =====================
// Validasi token aktivasi sebelum halaman membuat password ditampilkan
async function validateActivationToken(req, res) {
  try {
    const token =
      typeof req.query.token === 'string' ? req.query.token.trim() : '';

    if (!token) {
      return res.status(400).json({ message: 'Token aktivasi wajib diisi' });
    }

    const tokenHash = hashActivationToken(token);
    const activationToken = await prisma.accountActivationToken.findUnique({
      where: { token_hash: tokenHash },
      include: {
        user: {
          select: {
            id: true,
            activation_status: true,
            customer: { select: { name: true } },
          },
        },
      },
    });

    if (
      !activationToken ||
      activationToken.used_at ||
      activationToken.expires_at <= new Date() ||
      activationToken.user.activation_status !== 'pending_activation'
    ) {
      return res.status(400).json({
        message: 'Link aktivasi tidak valid atau sudah kedaluwarsa',
      });
    }

    return res.json({
      valid: true,
      customer_name: activationToken.user.customer?.name ?? null,
      expires_at: activationToken.expires_at,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// Mengaktifkan akun dan menyimpan password hash
async function activateAccount(req, res) {
  try {
    const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
    const password =
      typeof req.body.password === 'string' ? req.body.password : '';

    if (!token || password.trim().length < 8) {
      return res.status(400).json({
        message: 'Token wajib diisi dan password minimal 8 karakter',
      });
    }

    const tokenHash = hashActivationToken(token);
    const now = new Date();

    const activationToken = await prisma.accountActivationToken.findUnique({
      where: { token_hash: tokenHash },
      include: { user: true },
    });

    if (
      !activationToken ||
      activationToken.used_at ||
      activationToken.expires_at <= now ||
      activationToken.user.activation_status !== 'pending_activation'
    ) {
      return res.status(400).json({
        message: 'Link aktivasi tidak valid atau sudah kedaluwarsa',
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: activationToken.user_id },
        data: {
          password_hash: hashedPassword,
          activation_status: 'active',
          activated_at: now,
        },
      }),
      prisma.accountActivationToken.update({
        where: { id: activationToken.id },
        data: { used_at: now },
      }),
      prisma.session.deleteMany({
        where: { user_id: activationToken.user_id },
      }),
    ]);

    return res.json({
      message: 'Akun berhasil diaktifkan. Silakan login.',
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
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

    res.json(serializeAuthUser(user));
  } catch (error) {
    // Menangani error
    res.status(500).json({ error: error.message });
  }
}

// ===================== CHANGE PASSWORD =====================
// Mengganti password user yang sedang login
async function changePassword(req, res) {
  try {
    const currentPassword =
      typeof req.body.current_password === 'string'
        ? req.body.current_password
        : '';
    const newPassword =
      typeof req.body.new_password === 'string' ? req.body.new_password : '';

    if (!currentPassword || newPassword.trim().length < 8) {
      return res.status(400).json({
        message: 'Password lama wajib diisi dan password baru minimal 8 karakter',
      });
    }

    if (currentPassword === newPassword) {
      return res.status(400).json({
        message: 'Password baru harus berbeda dari password lama',
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        password_hash: true,
        activation_status: true,
      },
    });

    if (!user) {
      return res.status(404).json({ message: 'User tidak ditemukan' });
    }

    if (isSyncedPlaceholderUser(user)) {
      return res.status(409).json({
        message: 'Akun belum aktif. Silakan aktivasi akun terlebih dahulu.',
      });
    }

    const validPassword = await bcrypt.compare(
      currentPassword,
      user.password_hash,
    );

    if (!validPassword) {
      return res.status(401).json({ message: 'Password lama salah' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const token = req.headers.authorization?.split(' ')[1];

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { password_hash: hashedPassword },
      }),
      prisma.session.deleteMany({
        where: {
          user_id: user.id,
          ...(token ? { token: { not: token } } : {}),
        },
      }),
    ]);

    return res.json({ message: 'Password berhasil diganti' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// Mengekspor fungsi agar dapat digunakan oleh file route
module.exports = {
  register,
  login,
  profile,
  validateActivationToken,
  activateAccount,
  changePassword,
};

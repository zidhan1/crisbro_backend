// Mengimpor library untuk enkripsi password, JWT, database, dan layanan Runchise
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const getJwtSecret = require('../lib/jwtSecret');
const {
  createAccountActivationToken,
  hashActivationToken,
} = require('../services/accountActivationService');
const { sendActivationEmail } = require('../services/emailService');
const { getNextReward } = require('../services/nextRewardService');
const { respondWithServerError } = require('../lib/serverError');
const {
  setSessionCookie,
  clearSessionCookie,
} = require('../lib/sessionCookie');
const { normalizePhone, phoneVariants } = require('../lib/phoneNumber');
const {
  computeSessionExpiry,
  getSessionPolicy,
} = require('../lib/sessionPolicy');
const { hashSessionToken } = require('../lib/sessionToken');

// Satu pesan untuk semua kegagalan login, apa pun sebabnya.
const INVALID_CREDENTIALS_MESSAGE =
  'Nomor telepon atau password salah. Bila akun Anda belum pernah diaktivasi, hubungi Admin untuk menerima tautan aktivasi.';

// Hash bcrypt dari string acak yang tidak pernah dipakai siapa pun. Gunanya
// hanya agar bcrypt.compare tetap berjalan ketika nomor tidak ditemukan,
// sehingga durasi respons login seragam.
const DUMMY_PASSWORD_HASH =
  '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

// Mengecek apakah user hasil sinkronisasi dan belum memiliki password
function isSyncedPlaceholderUser(user) {
  return (
    user &&
    (user.password_hash === '' ||
      user.activation_status === 'pending_activation')
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
// Balasan seragam untuk /register. Wajib identik pada semua kondisi supaya
// endpoint ini tidak bisa dipakai memetakan nomor mana yang terdaftar.
const REGISTER_GENERIC_RESPONSE = {
  message:
    'Jika nomor tersebut terdaftar sebagai member, instruksi aktivasi akan dikirim ke email yang tercatat pada akun. Belum menerima instruksi? Hubungi Admin.',
  whatsappUrl:
    'https://wa.me/6282121214145?text=Halo%20Admin,%20saya%20ingin%20mengaktifkan%20akun%20member%20Crisbar.%20Mohon%20bantuannya.',
};

// Menangani permintaan aktivasi akun customer.
//
// PENTING - endpoint ini TIDAK BOLEH menyetel password.
//
// Versi sebelumnya mengaktifkan akun hanya bermodalkan nomor telepon: siapa pun
// yang menebak nomor member bisa memasang password pilihannya dan mengambil
// alih akun beserta poinnya, sekaligus menempelkan email sembarang yang membuka
// jalan reset password. Nomor telepon bukan bukti kepemilikan, dan aplikasi
// belum punya kanal OTP untuk membuktikannya.
//
// Satu-satunya jalur aktivasi yang sah adalah token aktivasi bertanda tangan
// (accountActivationService): token acak 32 byte, disimpan sebagai hash SHA-256,
// berlaku terbatas, dan dikirim ke email yang sudah tercatat pada akun. Fungsi
// ini hanya memicu pengiriman token tersebut.
async function register(req, res) {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const phone_number = normalizePhone(req.body.phone_number);

    if (!phone_number || !phone_number.startsWith('8') || !name) {
      return res.status(400).json({
        message: 'Nama dan nomor telepon (diawali 8) wajib diisi',
      });
    }

    const user = await prisma.user.findFirst({
      where: {
        phone_number: { in: phoneVariants(phone_number) },
      },
      select: {
        id: true,
        email: true,
        password_hash: true,
        activation_status: true,
      },
    });

    // Hanya akun yang memang belum pernah aktivasi dan punya email tercatat
    // yang bisa dikirimi tautan. Selain itu tidak ada tindakan apa pun, tetapi
    // balasannya tetap sama supaya keberadaan nomor tidak terungkap.
    if (user && isSyncedPlaceholderUser(user) && user.email) {
      const now = new Date();
      const activeToken = await prisma.accountActivationToken.findFirst({
        where: {
          user_id: user.id,
          purpose: 'activation',
          used_at: null,
          expires_at: { gt: now },
        },
      });

      // Token yang masih berlaku sengaja tidak diganti agar endpoint ini tidak
      // bisa dipakai membanjiri email seseorang dengan permintaan berulang.
      if (!activeToken) {
        const { activationUrl, expiresAt } = await createAccountActivationToken(
          user.id,
          'activation',
        );

        await sendActivationEmail({
          to: user.email,
          customerName: name,
          phoneNumber: phone_number,
          activationUrl,
          expiresAt,
        }).catch((error) => {
          console.error('Gagal mengirim email aktivasi:', error.message);
        });
      }
    }

    return res.status(202).json(REGISTER_GENERIC_RESPONSE);
  } catch (error) {
    console.error('Permintaan aktivasi gagal:', error);
    // Pesan tetap seragam agar kegagalan internal pun tidak membocorkan status
    // nomor yang dikirim.
    return res.status(202).json(REGISTER_GENERIC_RESPONSE);
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

    // Tahap 1: Mengambil hanya data yang diperlukan untuk verifikasi kredensial agar waktu respons tetap konsisten dan mengurangi risiko enumerasi akun.

    // M-13: Mengubah pencarian login menjadi findFirst agar mendukung berbagai format nomor telepon tanpa mengubah konsistensi waktu respons autentikasi.
    const credentials = await prisma.user.findFirst({
      where: { phone_number: { in: phoneVariants(phone_number) } },
      select: {
        id: true,
        role: true,
        password_hash: true,
        activation_status: true,
      },
    });

    // Menyeragamkan respons autentikasi dan tetap menjalankan verifikasi bcrypt pada seluruh kondisi gagal untuk mencegah enumerasi akun melalui perbedaan respons maupun waktu eksekusi.
    const isActivated =
      Boolean(credentials) && !isSyncedPlaceholderUser(credentials);
    const validPassword = await bcrypt.compare(
      password,
      isActivated ? credentials.password_hash : DUMMY_PASSWORD_HASH,
    );

    if (!isActivated || !validPassword) {
      return res.status(401).json({ message: INVALID_CREDENTIALS_MESSAGE });
    }

    // Tahap 2: kredensial sudah terbukti, barulah data profil dimuat.
    const user = await prisma.user.findUnique({
      where: { id: credentials.id },
      include: {
        customer: {
          include: { customer_point: true },
        },
      },
    });

    // H-2: masa berlaku sesi ditentukan per peran, bukan satu angka 7 hari untuk
    // semua orang. `exp` token menjadi batas absolut yang tidak bisa diperpanjang,
    // sedangkan baris Session menyimpan batas idle yang digeser middleware auth
    // selama user masih aktif.
    const sessionPolicy = getSessionPolicy(user.role);
    const token = jwt.sign({ id: user.id, role: user.role }, getJwtSecret(), {
      expiresIn: sessionPolicy.absoluteExpiresIn,
    });
    const decodedToken = jwt.decode(token);
    const now = Date.now();
    const tokenExpMs =
      decodedToken && typeof decodedToken.exp === 'number'
        ? decodedToken.exp * 1000
        : now + sessionPolicy.idleMs;
    const absoluteExpiresAt = new Date(tokenExpMs);
    const expiresAt = computeSessionExpiry({
      role: user.role,
      now,
      tokenExpMs,
    });

    await prisma.session.create({
      data: {
        user_id: user.id,
        token: hashSessionToken(token),
        expires_at: expiresAt,
      },
    });

    // Token sesi tidak diekspos ke JavaScript browser. Umur cookie disamakan
    // dengan batas absolut token: batas idle ditegakkan server lewat
    // `Session.expires_at`, dan request yang idle-nya sudah lewat tetap ditolak
    // 401 sekaligus menghapus cookie-nya.
    setSessionCookie(res, token, absoluteExpiresAt);
    res.json({
      expiresIn: sessionPolicy.absoluteExpiresIn,
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
    respondWithServerError(res, error, 'authController');
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
    return respondWithServerError(res, error, 'authController');
  }
}

// Mengaktifkan akun dan menyimpan password hash
async function activateAccount(req, res) {
  try {
    const token =
      typeof req.body.token === 'string' ? req.body.token.trim() : '';
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
    return respondWithServerError(res, error, 'authController');
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

    const serialized = serializeAuthUser(user);

    if (!serialized.customer) {
      return res.json(serialized);
    }

    // Target reward berikutnya dihitung di sini supaya dashboard tidak perlu
    // menebak ambang poin sendiri maupun menambah request ke katalog.
    const nextReward = await getNextReward(
      serialized.customer.customer_point?.available_point ?? 0,
    );

    res.json({
      ...serialized,
      customer: { ...serialized.customer, ...nextReward },
    });
  } catch (error) {
    // Menangani error
    respondWithServerError(res, error, 'authController');
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
        message:
          'Password lama wajib diisi dan password baru minimal 8 karakter',
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
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { password_hash: hashedPassword },
      }),
      prisma.session.deleteMany({
        where: { user_id: user.id },
      }),
    ]);

    return res.json({
      message: 'Password berhasil diganti. Silakan login ulang.',
    });
  } catch (error) {
    return respondWithServerError(res, error, 'authController');
  }
}

// Mengekspor fungsi agar dapat digunakan oleh file route
// ===================== LOGOUT =====================
// Mencabut sesi milik token yang sedang dipakai.
//
// Sebelumnya tidak ada endpoint ini: frontend hanya menghapus localStorage,
// sedangkan baris Session tetap hidup sampai kedaluwarsa. Middleware auth
// memvalidasi token terhadap tabel Session, jadi token yang sempat tersalin
// masih diterima sampai sepekan walau penggunanya sudah menekan "Keluar".
async function logout(req, res) {
  try {
    // Hanya sesi perangkat ini yang dihapus; perangkat lain milik user yang
    // sama tetap login.
    await prisma.session.deleteMany({
      where: { token: req.persistedSessionToken || req.sessionTokenHash },
    });
    clearSessionCookie(res);

    return res.json({ message: 'Berhasil keluar' });
  } catch (error) {
    clearSessionCookie(res);
    console.error('Logout gagal:', error);
    return res.status(500).json({ message: 'Gagal keluar dari sesi ini' });
  }
}

// Mengeluarkan seluruh perangkat milik user yang sedang login. Dipakai saat
// pengguna menduga akunnya dipakai orang lain.
async function logoutAllSessions(req, res) {
  try {
    const result = await prisma.session.deleteMany({
      where: { user_id: req.user.id },
    });
    clearSessionCookie(res);

    return res.json({
      message: 'Berhasil keluar dari semua perangkat',
      revoked_sessions: result.count,
    });
  } catch (error) {
    clearSessionCookie(res);
    console.error('Logout semua perangkat gagal:', error);
    return res
      .status(500)
      .json({ message: 'Gagal keluar dari semua perangkat' });
  }
}

module.exports = {
  register,
  login,
  logout,
  logoutAllSessions,
  profile,
  validateActivationToken,
  activateAccount,
  changePassword,
};

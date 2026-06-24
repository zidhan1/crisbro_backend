require('dotenv').config();

const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function normalizePhone(raw) {
  if (!raw) return raw;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('62')) return digits.slice(2);
  if (digits.startsWith('0')) return digits.slice(1);
  return digits;
}

async function main() {
  const phoneNumber = normalizePhone(process.env.ADMIN_PHONE_NUMBER);
  const password = process.env.ADMIN_PASSWORD;
  const email = process.env.ADMIN_EMAIL || null;

  if (!phoneNumber || !phoneNumber.startsWith('8')) {
    throw new Error('ADMIN_PHONE_NUMBER wajib diisi dengan format nomor Indonesia, contoh 081234567890');
  }

  if (!password || password.length < 8) {
    throw new Error('ADMIN_PASSWORD wajib diisi minimal 8 karakter');
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.upsert({
    where: { phone_number: phoneNumber },
    update: {
      email,
      password_hash: passwordHash,
      role: 'admin',
    },
    create: {
      email,
      phone_number: phoneNumber,
      password_hash: passwordHash,
      role: 'admin',
    },
    select: {
      id: true,
      email: true,
      phone_number: true,
      role: true,
    },
  });

  console.log('Admin user ready:', user);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

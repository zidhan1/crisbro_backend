// Mengimpor PrismaClient dari package Prisma
const { PrismaClient } = require("@prisma/client");

// Membuat satu instance PrismaClient untuk koneksi ke database
const prisma = new PrismaClient();

// Mengekspor instance Prisma agar dapat digunakan di file lain
module.exports = prisma;

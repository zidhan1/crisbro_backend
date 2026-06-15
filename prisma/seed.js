const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Seed brand
  await prisma.brand.upsert({
    where: { id: 1 },
    update: { name: 'Crisbar' },
    create: {
      id: 1,
      name: 'Crisbar',
      runchise_id: null,
    },
  });

  // Tandai gudang & kantor agar tidak tampil sebagai outlet
  const nonOutletNames = [
    'CK Crisbar Bandung',
    'DC Crisbar Bandung',
    'Office Crisbar',
  ];

  await prisma.location.updateMany({
    where: { name: { in: nonOutletNames } },
    data: { is_outlet: false },
  });

  console.log('Seed selesai.');
}

main().catch(console.error).finally(() => prisma.$disconnect());
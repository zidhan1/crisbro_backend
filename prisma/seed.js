const prisma = require('../src/lib/prisma');

await prisma.brand.upsert({
  where: { id: 1 },
  update: { name: 'Crisbar' },
  create: {
    id: 1,
    name: 'Crisbar',
    runchise_id: null,
  },
});

await prisma.location.upsert({
  where: { id: 1 },
  update: {},
  create: {
    id: 1,
    brand_id: 1,
    name: 'Antapani',
    is_active: true,
  },
});

main().catch(console.error).finally(() => prisma.$disconnect());
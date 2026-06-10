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

main().catch(console.error).finally(() => prisma.$disconnect());
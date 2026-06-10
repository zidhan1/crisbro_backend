const prisma = require('../lib/prisma');
const { fetchAllCustomers, fetchAllProducts, fetchAllSubBrands, fetchAllLocations } = require('./runchiseService');

// ── Sync Customers dari Runchise ke DB lokal ──
async function syncCustomers(locationId = 1) {
  const customers = await fetchAllCustomers(locationId);
  let synced = 0;

  for (const c of customers) {
    // ── Pastikan Brand ada dulu ──
    await prisma.brand.upsert({
      where:  { id: c.brand_id },
      update: {},
      create: { id: c.brand_id, name: `Brand ${c.brand_id}` },
    });

    const existing = await prisma.customer.findFirst({
      where: { runchise_id: c.id },
    });

    const payload = {
      runchise_id:               c.id,
      name:                      c.name,
      phone_number:              c.phone_number,
      phone_number_country_code: c.phone_number_country_code ?? 62,
      address:                   c.address ?? null,
      province:                  c.province ?? null,
      city:                      c.city ?? null,
      country:                   c.country ?? null,
      postal_code:               c.postal_code ?? null,
      dob:                       c.dob && !isNaN(new Date(c.dob)) ? new Date(c.dob) : null,
      gender:                    c.gender ?? 'unknown',
      status:                    c.status ?? 'active',
      balance:                   parseFloat(c.balance ?? 0),
      brand_id:                  c.brand_id,
      owner_location_id:         null, // skip dulu karena Location juga belum tentu ada
    };

    if (existing) {
      await prisma.customer.update({
        where: { id: existing.id },
        data:  payload,
      });
    } else {
      await prisma.user.create({
        data: {
          phone_number:  c.phone_number,
          password_hash: '',
          role:          'customer',
          customer: { create: payload },
        },
      });
    }
    synced++;
  }

  return { synced, total: customers.length };
}

async function syncCustomerPoints(locationId = 1) {
  // Fetch dari Runchise API dan dari DB secara paralel
  const [runchiseCustomers, localCustomers] = await Promise.all([
    fetchAllCustomers(locationId),
    prisma.customer.findMany({
      where: { runchise_id: { not: null } },
      select: { id: true, runchise_id: true },
    }),
  ]);

  // Buat map runchise_id → local id (lookup di memory, bukan query DB)
  const runchiseToLocal = new Map(
    localCustomers.map(c => [c.runchise_id, c.id])
  );

  const ops = [];

  for (const c of runchiseCustomers) {
    const localId = runchiseToLocal.get(c.id);
    if (!localId) continue;

    ops.push(
      prisma.customerPoint.upsert({
        where:  { customer_id: localId },
        update: {
          total_point:     c.total_point,
          available_point: c.available_point,
        },
        create: {
          customer_id:           localId,
          total_point:           c.total_point,
          available_point:       c.available_point,
          next_reward_threshold: 2000,
        },
      })
    );
  }

  await prisma.$transaction(ops);

  return { synced: ops.length, total: runchiseCustomers.length };
}

// ── Sync Products dari Runchise ke MenuItem DB lokal ──
async function syncProducts(brandId = 1) {
  const products = await fetchAllProducts();
  let synced = 0;

  for (const p of products) {
    // Pastikan category ada, atau buat baru jika belum ada
    let category;
    if (p.product_category?.id) {
      category = await prisma.menuCategory.upsert({
        where:  { id: p.product_category.id },
        update: { name: p.product_category.name },
        create: {
          id:       p.product_category.id,
          brand_id: brandId,
          name:     p.product_category.name,
        },
      });
    } else {
      // Produk tanpa kategori → masuk ke "Uncategorized"
      category = await prisma.menuCategory.upsert({
        where:  { id: 9999 },
        update: {},
        create: { id: 9999, brand_id: brandId, name: 'Uncategorized' },
      });
    }

    await prisma.menuItem.upsert({
      where:  { runchise_id: p.id },
      update: {
        name:        p.name,
        description: p.description ?? null,
        price:       parseFloat(p.sell_price),
        image_url:   p.image_url || null,
        is_active:   p.status === 'activated',
        category_id: category.id,
      },
      create: {
        runchise_id: p.id,
        brand_id:    brandId,
        category_id: category.id,
        name:        p.name,
        description: p.description ?? null,
        price:       parseFloat(p.sell_price),
        image_url:   p.image_url || null,
        is_active:   p.status === 'activated',
      },
    });
    synced++;
  }

  return { synced, total: products.length };
}

// ── Sync Brands dari Runchise ke DB lokal ──
async function syncBrands() {
  const subBrandsArray = await fetchAllSubBrands();

  if (!subBrandsArray || subBrandsArray.length === 0) {
    console.warn('Tidak ada data sub_brands dari API.');
    return { synced: 0, total: 0 };
  }

  console.log('Sample sub_brand dari API:', JSON.stringify(subBrandsArray[0], null, 2));

  let synced = 0;
  const seenParentBrandIds = new Set();

  for (const sb of subBrandsArray) {
    if (!sb.brand?.id || !sb.brand?.name) {
      console.warn(`Sub_brand id=${sb.id} tidak punya data brand, dilewati.`);
      continue;
    }

    const parentBrandId = sb.brand.id;
    const parentBrandName = sb.brand.name;

    // 1. Upsert parent brand (hanya sekali per brand unik)
    // Simpan sebagai runchise_id, bukan overwrite id lokal kamu
    if (!seenParentBrandIds.has(parentBrandId)) {
      seenParentBrandIds.add(parentBrandId);

      try {
        // Cari apakah brand dengan runchise_id ini sudah ada
        const existingBrand = await prisma.brand.findFirst({
          where: { runchise_id: parentBrandId },
        });

        if (!existingBrand) {
          await prisma.brand.create({
            data: {
              runchise_id: parentBrandId,
              name: parentBrandName || `Brand ${parentBrandId}`,
            },
          });
          console.log(`Parent brand dibuat: runchise_id=${parentBrandId}, name=${parentBrandName}`);
        }
      } catch (error) {
        console.error(`Gagal menyimpan parent brand runchise_id=${parentBrandId}:`, error.message);
        continue;
      }
    }

    // Ambil local brand id berdasarkan runchise_id
    const localBrand = await prisma.brand.findFirst({
      where: { runchise_id: parentBrandId },
    });

    if (!localBrand) {
      console.warn(`Local brand untuk runchise_id=${parentBrandId} tidak ditemukan, skip sub_brand id=${sb.id}`);
      continue;
    }

    // 2. Upsert sub_brand
    try {
      await prisma.subBrand.upsert({
        where: { runchise_id: sb.id },
        update: {
          name: sb.name,
          image_url: sb.image_url || null,
          location_type: sb.location_type || null,
          is_select_all_location: sb.is_select_all_location ?? false,
          enable_online_order: sb.enable_online_order ?? true,
          brand_id: localBrand.id,
        },
        create: {
          runchise_id: sb.id,
          brand_id: localBrand.id,
          name: sb.name,
          image_url: sb.image_url || null,
          location_type: sb.location_type || null,
          is_select_all_location: sb.is_select_all_location ?? false,
          enable_online_order: sb.enable_online_order ?? true,
        },
      });
      synced++;
      console.log(`Sub_brand synced: runchise_id=${sb.id}, name=${sb.name}`);
    } catch (error) {
      console.error(`Gagal menyimpan sub_brand id=${sb.id}:`, error.message);
    }
  }

  return { synced, total: subBrandsArray.length };
}

async function syncLocations(brandId = 1) {
  const locations = await fetchAllLocations();
  let synced = 0;

  for (const loc of locations) {
    // Pastikan brand ada dulu
    await prisma.brand.upsert({
      where:  { id: brandId },
      update: {},
      create: { id: brandId, name: `Brand ${brandId}` },
    });

    await prisma.location.upsert({
      where:  { id: loc.id },
      update: {
        name:       loc.name,
        address:    loc.shipping_address ?? null,
        city:       loc.city ?? null,
        province:   loc.province ?? null,
        latitude:   loc.latitude ? parseFloat(loc.latitude) : null,
        longitude:  loc.longitude ? parseFloat(loc.longitude) : null,
        is_active:  loc.status === 'activated',
        brand_id:   brandId,
        runchise_id: loc.is_franchise ? loc.id : null,
      },
      create: {
        id:          loc.id,
        brand_id:    brandId,
        runchise_id: loc.is_franchise ? loc.id : null,
        name:        loc.name,
        address:     loc.shipping_address ?? null,
        city:        loc.city ?? null,
        province:    loc.province ?? null,
        latitude:    loc.latitude ? parseFloat(loc.latitude) : null,
        longitude:   loc.longitude ? parseFloat(loc.longitude) : null,
        is_active:   loc.status === 'activated',
      },
    });

    synced++;
  }

  return { synced, total: locations.length };
}

module.exports = { syncCustomers, syncProducts, syncCustomerPoints, syncBrands, syncLocations };

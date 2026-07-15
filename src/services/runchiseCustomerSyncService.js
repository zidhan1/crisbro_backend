const prisma = require('../lib/prisma');
const {
  createCustomer,
  findCustomerByPhone,
  normalizeIndonesianPhone,
  updateCustomer,
} = require('./runchiseService');
const { ensureLocalLocationRunchiseMapping } = require('./syncService');

const SYNC_STATUS = {
  PENDING: 'pending',
  SYNCED: 'synced',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

function getSafeErrorMessage(error) {
  return String(error?.message || 'Gagal sinkron customer ke Runchise').slice(
    0,
    1000,
  );
}

function getRunchiseLocationId(customer) {
  const locationId =
    customer.owner_location?.runchise_id ??
    customer.runchise_location_id ??
    Number(process.env.RUNCHISE_DEFAULT_LOCATION_ID);

  return Number.isInteger(Number(locationId)) && Number(locationId) > 0
    ? Number(locationId)
    : null;
}

function buildRunchiseCustomerInput(customer, runchiseLocationId) {
  return {
    name: customer.name,
    phone_number: customer.phone_number,
    phone_number_country_code: customer.phone_number_country_code,
    address: customer.address,
    province: customer.province,
    city: customer.city,
    country: customer.country,
    postal_code: customer.postal_code,
    dob: customer.dob,
    gender: customer.gender,
    email: customer.user?.email,
    owner_location_id: runchiseLocationId,
  };
}

async function updateSyncStatus(customerId, data) {
  const coreData = {};
  const syncColumnMap = {
    runchise_location_id: '"runchise_location_id"',
    runchise_sync_status: '"runchise_sync_status"',
    runchise_sync_error: '"runchise_sync_error"',
    runchise_synced_at: '"runchise_synced_at"',
    normalized_phone_number: '"normalized_phone_number"',
  };
  const syncEntries = [];

  if (Object.prototype.hasOwnProperty.call(data, 'runchise_id')) {
    coreData.runchise_id = data.runchise_id;
  }

  for (const [field, column] of Object.entries(syncColumnMap)) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      syncEntries.push([column, data[field]]);
    }
  }

  if (Object.keys(coreData).length > 0) {
    await prisma.customer.update({
      where: { id: customerId },
      data: coreData,
    });
  }

  if (syncEntries.length > 0) {
    const assignments = syncEntries
      .map(([column], index) => `${column} = $${index + 1}`)
      .join(', ');
    const values = syncEntries.map(([, value]) => value);

    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "Customer" SET ${assignments} WHERE "id" = $${values.length + 1}`,
        ...values,
        customerId,
      );
    } catch (error) {
      console.warn(
        'Status sync Runchise belum tersimpan. Jalankan migration dan prisma generate.',
        error.message,
      );
    }
  }
}

async function syncCustomerToRunchise(customerId) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: {
      user: { select: { email: true } },
      owner_location: { select: { id: true, name: true, city: true, runchise_id: true } },
    },
  });

  if (!customer) {
    throw Object.assign(new Error('Customer tidak ditemukan'), {
      code: 'P2025',
    });
  }

  if (!process.env.RUNCHISE_API_KEY) {
    await updateSyncStatus(customer.id, {
      runchise_sync_status: SYNC_STATUS.SKIPPED,
      runchise_sync_error: 'RUNCHISE_API_KEY belum dikonfigurasi',
      normalized_phone_number:
        customer.normalized_phone_number ||
        normalizeIndonesianPhone(customer.phone_number),
    });

    return {
      status: SYNC_STATUS.SKIPPED,
      skipped: true,
      reason: 'missing_runchise_api_key',
    };
  }

  const normalizedPhone = normalizeIndonesianPhone(customer.phone_number);
  if (!normalizedPhone) {
    await updateSyncStatus(customer.id, {
      runchise_sync_status: SYNC_STATUS.FAILED,
      runchise_sync_error: 'Nomor telepon customer tidak valid',
      normalized_phone_number: null,
    });

    return { status: SYNC_STATUS.FAILED, error: 'Nomor telepon customer tidak valid' };
  }

  let customerForSync = customer;

  if (customer.owner_location_id && !customer.owner_location?.runchise_id) {
    const mappedLocation = await ensureLocalLocationRunchiseMapping(
      customer.owner_location_id,
      customer.brand_id,
    );

    if (mappedLocation) {
      customerForSync = {
        ...customer,
        owner_location: mappedLocation,
      };
    }
  }

  const runchiseLocationId = getRunchiseLocationId(customerForSync);
  if (!runchiseLocationId) {
    await updateSyncStatus(customer.id, {
      runchise_sync_status: SYNC_STATUS.SKIPPED,
      runchise_sync_error:
        'Outlet belum terhubung dengan location_id Runchise. Jalankan sync lokasi atau isi Location.runchise_id.',
      normalized_phone_number: normalizedPhone,
    });

    return {
      status: SYNC_STATUS.SKIPPED,
      skipped: true,
      reason: 'missing_runchise_location',
    };
  }

  await updateSyncStatus(customer.id, {
    runchise_sync_status: SYNC_STATUS.PENDING,
    runchise_sync_error: null,
    runchise_location_id: runchiseLocationId,
    normalized_phone_number: normalizedPhone,
  });

  try {
    const customerInput = buildRunchiseCustomerInput(
      customer,
      runchiseLocationId,
    );
    const existingByPhone = await findCustomerByPhone(
      runchiseLocationId,
      customer.phone_number,
    );
    let matchedExisting = false;
    let usedPatch = false;
    let runchiseCustomer = null;

    if (customer.runchise_id) {
      if (
        existingByPhone?.id &&
        Number(existingByPhone.id) !== Number(customer.runchise_id)
      ) {
        await updateSyncStatus(customer.id, {
          runchise_id: Number(existingByPhone.id),
          runchise_location_id: runchiseLocationId,
          runchise_sync_status: SYNC_STATUS.SYNCED,
          runchise_sync_error: null,
          runchise_synced_at: new Date(),
          normalized_phone_number: normalizedPhone,
        });

        return {
          status: SYNC_STATUS.SYNCED,
          runchise_customer_id: Number(existingByPhone.id),
          matched_existing: true,
          relinked_existing: true,
          updated_existing: false,
        };
      }

      try {
        runchiseCustomer = (
          await updateCustomer(
            runchiseLocationId,
            customer.runchise_id,
            customerInput,
          )
        )?.customer;
        usedPatch = true;
      } catch (error) {
        if (existingByPhone?.id) {
          runchiseCustomer = (
            await updateCustomer(
              runchiseLocationId,
              existingByPhone.id,
              customerInput,
            )
          )?.customer;
          matchedExisting = true;
          usedPatch = true;
        } else {
          runchiseCustomer = (
            await createCustomer(runchiseLocationId, customerInput)
          )?.customer;
          usedPatch = false;
        }
      }
    } else {
      if (existingByPhone) {
        runchiseCustomer = (
          await updateCustomer(
            runchiseLocationId,
            existingByPhone.id,
            customerInput,
          )
        )?.customer;
        matchedExisting = true;
        usedPatch = true;
      } else {
        runchiseCustomer = (
          await createCustomer(runchiseLocationId, customerInput)
        )?.customer;
      }
    }

    if (!runchiseCustomer?.id) {
      throw new Error('Response Runchise tidak menyertakan customer.id');
    }

    await updateSyncStatus(customer.id, {
      runchise_id: Number(runchiseCustomer.id),
      runchise_location_id: runchiseLocationId,
      runchise_sync_status: SYNC_STATUS.SYNCED,
      runchise_sync_error: null,
      runchise_synced_at: new Date(),
      normalized_phone_number: normalizedPhone,
    });

    return {
      status: SYNC_STATUS.SYNCED,
      runchise_customer_id: Number(runchiseCustomer.id),
      matched_existing: matchedExisting,
      updated_existing: usedPatch,
    };
  } catch (error) {
    const message = getSafeErrorMessage(error);

    await updateSyncStatus(customer.id, {
      runchise_sync_status: SYNC_STATUS.FAILED,
      runchise_sync_error: message,
      runchise_synced_at: null,
      normalized_phone_number: normalizedPhone,
    });

    return { status: SYNC_STATUS.FAILED, error: message };
  }
}

module.exports = {
  SYNC_STATUS,
  syncCustomerToRunchise,
};

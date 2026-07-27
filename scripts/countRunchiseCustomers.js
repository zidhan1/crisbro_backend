const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const BASE_URL = 'https://api.runchise.com/api/public';
const DEFAULT_LOCATION_ID = 4453;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGES = 100000;
const MAX_RETRIES = 3;

function printHelp() {
  console.log(`
Menghitung seluruh customer unik pada satu lokasi Runchise.

Penggunaan:
  node scripts/countRunchiseCustomers.js [location_id]

Contoh:
  node scripts/countRunchiseCustomers.js 4453  # Antapani
  node scripts/countRunchiseCustomers.js 4576  # UIN Bandung

Jika location_id tidak diberikan, script memakai Antapani (${DEFAULT_LOCATION_ID}).
API key dibaca dari RUNCHISE_API_KEY di file .env.
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLocationId(rawValue) {
  const locationId = Number(rawValue ?? DEFAULT_LOCATION_ID);

  if (!Number.isInteger(locationId) || locationId <= 0) {
    throw new Error(`location_id tidak valid: ${rawValue}`);
  }

  return locationId;
}

function isRetryable(error) {
  const status = error.response?.status;
  return (
    !error.response ||
    status === 408 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

async function fetchPage(client, url, pageNumber) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.get(url);
      return response.data;
    } catch (error) {
      lastError = error;

      if (!isRetryable(error) || attempt === MAX_RETRIES) {
        break;
      }

      const retryAfterSeconds = Number(error.response?.headers?.['retry-after']);
      const delayMs = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds * 1000
        : 1000 * 2 ** attempt;

      console.warn(
        `Halaman ${pageNumber} gagal (${error.response?.status || error.code || error.message}); ` +
          `mencoba ulang ${attempt + 1}/${MAX_RETRIES} dalam ${delayMs} ms...`,
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

async function countCustomers(locationId) {
  const apiKey = process.env.RUNCHISE_API_KEY;
  if (!apiKey) {
    throw new Error('RUNCHISE_API_KEY belum tersedia di file .env');
  }

  const client = axios.create({
    baseURL: BASE_URL,
    timeout: Number(process.env.RUNCHISE_API_TIMEOUT_MS || 30000),
    headers: {
      Accept: 'application/json',
      Authorization: apiKey,
    },
  });

  let nextUrl = `/locations/${locationId}/customers?page=1&item_per_page=${DEFAULT_PAGE_SIZE}`;
  let pageCount = 0;
  let receivedRows = 0;
  let duplicateRows = 0;
  let invalidRows = 0;
  let customersWithoutRequestedLocation = 0;
  let firstReportedTotal = null;
  const uniqueCustomerIds = new Set();
  const visitedUrls = new Set();
  const locationMismatches = [];

  console.log(`Menghitung customer lokasi Runchise ${locationId}...`);

  while (nextUrl !== null) {
    if (pageCount >= MAX_PAGES) {
      throw new Error(`Dihentikan karena melewati batas aman ${MAX_PAGES} halaman`);
    }

    if (visitedUrls.has(nextUrl)) {
      throw new Error(`Pagination berulang pada URL: ${nextUrl}`);
    }
    visitedUrls.add(nextUrl);

    const expectedPage = pageCount + 1;
    const data = await fetchPage(client, nextUrl, expectedPage);
    const customers = data?.customers;

    if (!Array.isArray(customers)) {
      throw new Error(`Response halaman ${expectedPage} tidak memiliki array customers`);
    }

    pageCount++;
    receivedRows += customers.length;

    if (firstReportedTotal === null && data.paging?.total_item != null) {
      firstReportedTotal = Number(data.paging.total_item);
    }

    for (const customer of customers) {
      const customerId = Number(customer?.id);
      if (!Number.isInteger(customerId) || customerId <= 0) {
        invalidRows++;
        continue;
      }

      if (uniqueCustomerIds.has(customerId)) {
        duplicateRows++;
      } else {
        uniqueCustomerIds.add(customerId);
      }

      const locationIds = Array.isArray(customer.location_ids)
        ? customer.location_ids.map(Number)
        : [];
      if (!locationIds.includes(locationId)) {
        customersWithoutRequestedLocation++;
        locationMismatches.push({
          page: data.paging?.current_page ?? pageCount,
          customer_id: customerId,
          name: customer.name ?? null,
          phone_number: customer.phone_number ?? null,
          owner_location_id: customer.owner_location_id ?? null,
          owner_location_name: customer.owner_location?.name ?? null,
          location_ids: locationIds.join(', ') || '(kosong)',
        });
      }
    }

    const currentPage = data.paging?.current_page ?? pageCount;
    console.log(
      `Halaman ${currentPage}: ${customers.length} baris; ` +
        `total diterima ${receivedRows}; unik ${uniqueCustomerIds.size}`,
    );

    nextUrl = data.paging?.next_page ?? null;
  }

  const result = {
    location_id: locationId,
    pages_fetched: pageCount,
    api_reported_total_item: firstReportedTotal,
    rows_received: receivedRows,
    unique_customers: uniqueCustomerIds.size,
    duplicate_rows: duplicateRows,
    invalid_rows: invalidRows,
    customers_without_location_id: customersWithoutRequestedLocation,
    complete: true,
  };

  console.log('\n=== HASIL AKHIR ===');
  console.log(JSON.stringify(result, null, 2));

  if (locationMismatches.length > 0) {
    console.log(
      `\n=== ${locationMismatches.length} CUSTOMER TANPA LOCATION_ID ${locationId} ===`,
    );
    console.table(locationMismatches);
  }

  if (firstReportedTotal === 10000 && uniqueCustomerIds.size > 10000) {
    console.log(
      '\nCatatan: total_item API berhenti di 10000, tetapi pagination membuktikan jumlah asli lebih besar.',
    );
  }

  return result;
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const locationId = parseLocationId(process.argv[2]);
  await countCustomers(locationId);
}

main().catch((error) => {
  const status = error.response?.status;
  const apiMessage = error.response?.data?.message;
  console.error(
    `\nGagal menghitung customer${status ? ` (HTTP ${status})` : ''}: ` +
      `${apiMessage || error.message}`,
  );
  process.exitCode = 1;
});

module.exports = { countCustomers };

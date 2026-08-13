const { Client } = require('pg');
const prisma = require('../lib/prisma');
const {
  fetchProductsPage,
  fetchPromosPage,
  fetchSubBrandsPage,
  fetchLocationsPage,
  RUNCHISE_REQUEST_TIMEOUT_MS,
} = require('./runchiseService');
const {
  syncBrands,
  syncLocations,
  loadCrisbarPromoContext,
  getCrisbarPromoEvidence,
  mapRunchisePromoToLocalData,
  upsertPromoChunk,
} = require('./syncService');
const {
  loadCrisbarContext,
  mapProduct,
  upsertChunk,
} = require('../../scripts/importSelectedCrisbarProducts');
const { clampWorkerBudgetMs, hasTimeForNextRequest } = require('../lib/serverlessBudget');

const KINDS = new Set(['products', 'promos', 'brands', 'locations']);
const PAGE_CAPS = Object.freeze({ products: 500, promos: 200, brands: 500, locations: 200 });
const PAGE_SIZES = Object.freeze({ products: 50, promos: 50 });
const WORKER_LOCK_ID = 750954839;
const DEFAULT_BUDGET_MS = 18_000;

function createClient() { return new Client({ connectionString: process.env.DATABASE_URL }); }
function assertKind(kind) { if (!KINDS.has(kind)) throw new Error(`Jenis catalog sync tidak valid: ${kind}`); }
function serialize(row) { return row ? { ...row, seen_ids: Array.isArray(row.seen_ids) ? row.seen_ids : [] } : null; }

async function createCatalogSyncJob(kind, { source = 'cron' } = {}, deps = {}) {
  assertKind(kind);
  const client = (deps.createClient || createClient)();
  try {
    await client.connect();
    const existing = await client.query(`SELECT * FROM "CatalogSyncJob" WHERE "kind"=$1 AND "status" IN ('queued','running') ORDER BY "id" DESC LIMIT 1`, [kind]);
    if (existing.rows[0]) return { created: false, job: serialize(existing.rows[0]) };
    const inserted = await client.query(`INSERT INTO "CatalogSyncJob" ("kind","source") VALUES ($1,$2) RETURNING *`, [kind, source]);
    return { created: true, job: serialize(inserted.rows[0]) };
  } finally { await client.end().catch(() => {}); }
}

function pageHasNext(data, items, processed) {
  if (data.paging?.next_page !== undefined) return data.paging.next_page !== null;
  const total = Number(data.paging?.total_item);
  return Number.isFinite(total) ? processed < total : items.length > 0;
}

async function processKindPage(kind, page, seen, deps = {}) {
  if (page > PAGE_CAPS[kind]) {
    const error = new Error(`${kind} pagination melebihi batas realistis ${PAGE_CAPS[kind]} halaman`);
    error.code = 'RUNCHISE_MAX_PAGES_EXCEEDED';
    throw error;
  }
  if (kind === 'products') {
    const data = await (deps.fetchProductsPage || fetchProductsPage)({ page, itemPerPage: PAGE_SIZES.products }, { retries: 0 });
    const context = await (deps.loadProductContext || loadCrisbarContext)(prisma);
    const mapped = data.products.filter((p) => context.categoryIds.has(Number(p?.product_category?.id))).map((p) => mapProduct(p, context));
    for (const item of mapped) { if (seen.has(item.runchise_id)) throw new Error(`Produk duplikat antar halaman: ${item.runchise_id}`); seen.add(item.runchise_id); }
    for (let i = 0; i < mapped.length; i += 20) await (deps.upsertProductChunk || upsertChunk)(prisma, mapped.slice(i, i + 20));
    return { data, items: data.products, synced: mapped.length };
  }
  if (kind === 'promos') {
    const data = await (deps.fetchPromosPage || fetchPromosPage)({ page, itemPerPage: PAGE_SIZES.promos }, { retries: 0 });
    const context = await (deps.loadPromoContext || loadCrisbarPromoContext)();
    const mapped = [];
    for (const raw of data.promos) {
      const id = Number(raw?.id); if (!Number.isInteger(id) || id <= 0) throw new Error('Promo ID tidak valid');
      if (getCrisbarPromoEvidence(raw, context)) {
        if (seen.has(id)) throw new Error(`Promo duplikat antar halaman: ${id}`);
        seen.add(id);
        mapped.push(mapRunchisePromoToLocalData(raw, context, new Date()));
      }
    }
    for (let i = 0; i < mapped.length; i += 20) await (deps.upsertPromoChunk || upsertPromoChunk)(mapped.slice(i, i + 20));
    return { data, items: data.promos, synced: mapped.length };
  }
  if (kind === 'brands') {
    const data = await (deps.fetchSubBrandsPage || fetchSubBrandsPage)(page, { retries: 0 });
    const result = await (deps.syncBrands || syncBrands)(data.sub_brands);
    if (Number(result.failed) > 0) throw new Error(`${result.failed} sub-brand gagal ditulis; halaman akan diulang`);
    data.sub_brands.forEach((x) => { const id=Number(x.id); if (seen.has(id)) throw new Error(`Sub-brand duplikat: ${id}`); seen.add(id); });
    return { data, items: data.sub_brands, synced: result.synced };
  }
  const data = await (deps.fetchLocationsPage || fetchLocationsPage)(page, { retries: 0 });
  const result = await (deps.syncLocations || syncLocations)(Number(process.env.RUNCHISE_SYNC_BRAND_ID || 1), data.locations);
  data.locations.forEach((x) => { const id=Number(x.id); if (seen.has(id)) throw new Error(`Location duplikat: ${id}`); seen.add(id); });
  return { data, items: data.locations, synced: result.synced };
}

async function finalize(kind, seen) {
  const ids = [...seen];
  if ((kind === 'products' || kind === 'promos') && ids.length === 0) throw new Error(`${kind} tidak menghasilkan data; rekonsiliasi dibatalkan`);
  if (kind === 'products') {
    const context = await loadCrisbarContext(prisma);
    await prisma.menuItem.updateMany({
      where: {
        category_id: { in: [...context.categoryIds] },
        runchise_id: { not: null, notIn: ids },
        is_active: true,
      },
      data: { is_active: false },
    });
  }
  if (kind === 'promos') await prisma.promo.deleteMany({ where: { runchise_id: { notIn: ids } } });
}

async function processCatalogSyncJobs({ timeBudgetMs = DEFAULT_BUDGET_MS, maxPages = 10, kind = null } = {}, deps = {}) {
  if (kind !== null) assertKind(kind);
  const client = (deps.createClient || createClient)(); let locked=false; let activeId=null;
  try {
    await client.connect();
    const lock = await client.query('SELECT pg_try_advisory_lock($1) acquired', [WORKER_LOCK_ID]); locked=lock.rows[0]?.acquired===true;
    if (!locked) return { status: 'already_running' };
    const active = await client.query(`SELECT * FROM "CatalogSyncJob" WHERE "status" IN ('queued','running') AND ($1::text IS NULL OR "kind"=$1) ORDER BY "started_at","id" LIMIT 1`, [kind]);
    let job=active.rows[0]; if (!job) return { status:'idle', job:null }; activeId=job.id;
    await client.query(`UPDATE "CatalogSyncJob" SET "status"='running',"heartbeat_at"=NOW(),"error"=NULL WHERE "id"=$1`,[job.id]);
    const deadline=Date.now()+clampWorkerBudgetMs(timeBudgetMs,DEFAULT_BUDGET_MS,{min:3000}); let pages=0;
    do {
      const seen=new Set(Array.isArray(job.seen_ids)?job.seen_ids:[]); const page=Number(job.current_page)||1;
      const result=await processKindPage(job.kind,page,seen,deps); const processed=Number(job.processed)+result.items.length;
      const reported=Number(result.data.paging?.total_item); const prior=job.reported_total==null?null:Number(job.reported_total);
      if (Number.isFinite(reported) && prior!==null && prior!==reported) throw new Error(`total_item ${job.kind} berubah: ${prior} -> ${reported}`);
      const hasNext=pageHasNext(result.data,result.items,processed);
      if (!hasNext) { if (Number.isFinite(reported)&&processed!==reported) throw new Error(`Pagination ${job.kind} tidak lengkap: ${processed}/${reported}`); await (deps.finalize||finalize)(job.kind,seen); }
      const updated=await client.query(`UPDATE "CatalogSyncJob" SET "status"=$2,"current_page"=$3,"reported_total"=COALESCE("reported_total",$4),"pages_processed"="pages_processed"+1,"processed"=$5,"synced"="synced"+$6,"seen_ids"=$7::jsonb,"consecutive_failures"=0,"heartbeat_at"=NOW(),"finished_at"=CASE WHEN $2='completed' THEN NOW() ELSE NULL END WHERE "id"=$1 RETURNING *`,[job.id,hasNext?'running':'completed',hasNext?page+1:page,Number.isFinite(reported)?reported:null,processed,result.synced,JSON.stringify([...seen])]);
      job=updated.rows[0]; pages++; if (!hasNext) return {status:'completed',job:serialize(job)};
    } while (pages<Math.min(Math.max(Number(maxPages)||1,1),20)&&hasTimeForNextRequest(deadline,RUNCHISE_REQUEST_TIMEOUT_MS));
    return {status:'running',job:serialize(job)};
  } catch(error) {
    if(activeId!==null) await client.query(`UPDATE "CatalogSyncJob" SET "consecutive_failures"="consecutive_failures"+1,"status"=CASE WHEN $2 OR "consecutive_failures"+1>=3 THEN 'failed' ELSE 'queued' END,"error"=$1,"heartbeat_at"=NOW(),"finished_at"=CASE WHEN $2 OR "consecutive_failures"+1>=3 THEN NOW() ELSE NULL END WHERE "id"=$3`,[String(error.message).slice(0,4000),error.code==='RUNCHISE_MAX_PAGES_EXCEEDED',activeId]).catch(()=>{});
    throw error;
  } finally { if(locked) await client.query('SELECT pg_advisory_unlock($1)',[WORKER_LOCK_ID]).catch(()=>{}); await client.end().catch(()=>{}); }
}

module.exports={ createCatalogSyncJob, processCatalogSyncJobs, processKindPage, PAGE_CAPS };

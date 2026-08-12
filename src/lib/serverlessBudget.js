// Harus sama dengan `functions.api/index.js.maxDuration` di vercel.json.
// Satu sumber konstanta di aplikasi membuat worker tidak bebas menerima budget
// environment yang lebih panjang daripada umur function deployment.
const SERVERLESS_MAX_DURATION_MS = 30_000;

// Dicadangkan untuk menyimpan checkpoint/error, melepas advisory lock, menutup
// koneksi PostgreSQL, mengirim response, dan overhead runtime/cold start.
const SERVERLESS_SHUTDOWN_RESERVE_MS = 10_000;
const MAX_WORKER_BUDGET_MS =
  SERVERLESS_MAX_DURATION_MS - SERVERLESS_SHUTDOWN_RESERVE_MS;

function clampWorkerBudgetMs(value, fallback, { min = 1_000 } = {}) {
  const parsed = Number(value);
  const fallbackValue = Number(fallback);
  const candidate = Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;

  return Math.min(Math.max(candidate, min), MAX_WORKER_BUDGET_MS);
}

// Jangan mulai unit kerja eksternal baru jika worst-case request-nya tidak lagi
// muat dalam budget worker. Tanpa admission guard ini, pengecekan `now <
// deadline` dapat meloloskan request tepat sebelum deadline dan membuat worker
// melewati budget sampai sebesar satu timeout penuh.
function hasTimeForNextRequest(deadline, requestTimeoutMs, now = Date.now()) {
  // Harus lebih besar, bukan sama: selain HTTP request masih ada parsing dan
  // penulisan checkpoint halaman yang wajib selesai di dalam budget worker.
  return Number(deadline) - Number(now) > Number(requestTimeoutMs);
}

module.exports = {
  MAX_WORKER_BUDGET_MS,
  SERVERLESS_MAX_DURATION_MS,
  SERVERLESS_SHUTDOWN_RESERVE_MS,
  clampWorkerBudgetMs,
  hasTimeForNextRequest,
};

// Saklar untuk menghentikan sementara sinkronisasi customer dari Runchise.
//
// Alasan: impor customer menulis puluhan ribu baris Customer/User baru dan
// menjadi penyumbang pertumbuhan database terbesar. Pause tetap tersedia
// sebagai pengaman kapasitas database, tetapi deployment baru tidak boleh
// diam-diam melewatkan sinkronisasi.
//
// Sinkronisasi aktif secara default agar deployment baru tidak diam-diam
// melewatkan pemrosesan customer. Operator dapat menghentikannya sementara
// dengan menyetel RUNCHISE_CUSTOMER_SYNC_ENABLED="false" secara eksplisit.
//
// PENTING: menjeda BUKAN membatalkan. Baris CustomerImportSyncJob yang
// berstatus queued/running sengaja dibiarkan apa adanya beserta cursor-nya
// (current_location_index / current_page), sehingga ketika saklar
// dinyalakan lagi worker melanjutkan dari halaman terakhir, bukan mengulang
// dari nol.
function isCustomerSyncEnabled() {
  return process.env.RUNCHISE_CUSTOMER_SYNC_ENABLED !== 'false';
}

// Bentuk balasan seragam untuk semua jalur (cron, worker, route admin) agar
// pemanggil bisa membedakan "dijeda administrator" dari "tidak ada job" atau
// "job sedang dikerjakan instance lain".
function customerSyncDisabledResult(job = null) {
  return {
    status: 'disabled',
    skipped: true,
    reason: 'customer_sync_disabled',
    message:
      'Sinkronisasi customer Runchise sedang dinonaktifkan sementara. ' +
      'Hapus RUNCHISE_CUSTOMER_SYNC_ENABLED atau setel ke true untuk mengaktifkannya kembali.',
    job,
  };
}

module.exports = { isCustomerSyncEnabled, customerSyncDisabledResult };

// Saklar untuk menghentikan sementara sinkronisasi customer dari Runchise.
//
// Alasan: impor customer menulis puluhan ribu baris Customer/User baru dan
// menjadi penyumbang pertumbuhan database terbesar. Selama kapasitas
// database masih terbatas, impor ini dijeda dan aplikasi memakai data
// customer yang sudah tersimpan.
//
// Sengaja OPT-IN (default mati): sinkronisasi hanya berjalan bila
// RUNCHISE_CUSTOMER_SYNC_ENABLED di-set persis "true". Jadi tidak ada jalur
// yang diam-diam menghidupkannya kembali karena env belum dikonfigurasi.
//
// PENTING: menjeda BUKAN membatalkan. Baris CustomerImportSyncJob yang
// berstatus queued/running sengaja dibiarkan apa adanya beserta cursor-nya
// (current_location_index / current_page), sehingga ketika saklar
// dinyalakan lagi worker melanjutkan dari halaman terakhir, bukan mengulang
// dari nol.
function isCustomerSyncEnabled() {
  return process.env.RUNCHISE_CUSTOMER_SYNC_ENABLED === 'true';
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
      'Set RUNCHISE_CUSTOMER_SYNC_ENABLED=true untuk mengaktifkannya kembali.',
    job,
  };
}

module.exports = { isCustomerSyncEnabled, customerSyncDisabledResult };

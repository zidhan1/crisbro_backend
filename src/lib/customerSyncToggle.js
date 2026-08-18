// Saklar untuk menghentikan sementara sinkronisasi customer dari Runchise.
//
// Alasan: impor customer menulis puluhan ribu baris Customer/User baru dan
// menjadi penyumbang pertumbuhan database terbesar.
//
// PENTING: menjeda BUKAN membatalkan. Baris CustomerImportSyncJob yang
// berstatus queued/running sengaja dibiarkan apa adanya beserta cursor-nya
// (current_location_index / current_page), sehingga ketika saklar
// dinyalakan lagi worker melanjutkan dari halaman terakhir, bukan mengulang
// dari nol.

// ===========================================================================
// JEDA MANUAL — disetel 18 Agustus 2026 atas permintaan operator.
//
// Kondisi saat dijeda (Job #2): 33.800 record API diproses, 31.850 customer
// dibuat, 1.849 diperbarui, baru 3 dari 29 outlet, fase "recent", halaman 39.
// Kapasitas database sudah terlalu penuh untuk melanjutkan.
//
// CARA MENYALAKAN KEMBALI: ubah satu baris di bawah ini menjadi `false`.
// Tidak perlu menyentuh env apa pun. Job #2 beserta cursor outlet/halamannya
// tetap utuh, jadi impor lanjut dari tempat terakhir -- bukan mengulang.
//
// Jeda ini sengaja MENANG atas RUNCHISE_CUSTOMER_SYNC_ENABLED supaya
// berhentinya pasti, tanpa bergantung pada nilai env di dashboard hosting
// yang tidak terlihat dari repositori ini.
// ===========================================================================
const CUSTOMER_SYNC_PAUSED_IN_CODE = true;

// Semantik env dipertahankan apa adanya supaya tetap berlaku persis seperti
// semula begitu jeda di atas dilepas: aktif secara default, dan hanya string
// "false" yang persis yang mematikannya.
function isCustomerSyncEnabledFromEnv(env = process.env) {
  return env.RUNCHISE_CUSTOMER_SYNC_ENABLED !== 'false';
}

function isCustomerSyncEnabled() {
  if (CUSTOMER_SYNC_PAUSED_IN_CODE) return false;
  return isCustomerSyncEnabledFromEnv();
}

// Bentuk balasan seragam untuk semua jalur (cron, worker, route admin) agar
// pemanggil bisa membedakan "dijeda administrator" dari "tidak ada job" atau
// "job sedang dikerjakan instance lain".
function customerSyncDisabledResult(job = null) {
  // Pesannya mengikuti mekanisme yang benar-benar mematikan. Menyuruh operator
  // mengubah env padahal yang menghentikan adalah jeda di kode hanya akan
  // membuat mereka menyetel env, melihat sinkronisasi tetap mati, lalu bingung.
  const message = CUSTOMER_SYNC_PAUSED_IN_CODE
    ? 'Sinkronisasi customer Runchise sedang dijeda dari kode ' +
      '(CUSTOMER_SYNC_PAUSED_IN_CODE di src/lib/customerSyncToggle.js). ' +
      'Job dan cursor terakhir tetap tersimpan dan akan dilanjutkan saat jeda dilepas.'
    : 'Sinkronisasi customer Runchise sedang dinonaktifkan sementara. ' +
      'Hapus RUNCHISE_CUSTOMER_SYNC_ENABLED atau setel ke true untuk mengaktifkannya kembali.';

  return {
    status: 'disabled',
    skipped: true,
    reason: 'customer_sync_disabled',
    message,
    job,
  };
}

module.exports = {
  CUSTOMER_SYNC_PAUSED_IN_CODE,
  isCustomerSyncEnabled,
  isCustomerSyncEnabledFromEnv,
  customerSyncDisabledResult,
};

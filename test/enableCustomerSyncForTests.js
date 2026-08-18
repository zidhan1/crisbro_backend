// Sinkronisasi customer sedang DIJEDA dari kode
// (CUSTOMER_SYNC_PAUSED_IN_CODE di src/lib/customerSyncToggle.js).
//
// Sebagian test menguji perilaku worker SAAT MENYALA -- misalnya job ditandai
// failed ketika cap halaman terlampaui, atau di-requeue saat error sementara.
// Perilaku itu harus tetap dijaga selama jeda berlangsung, jadi test tersebut
// menyalakan saklarnya sendiri lewat modul ini, bukan dengan melepas jeda.
//
// WAJIB di-require SEBELUM service customer di-require, karena service
// mengambil isCustomerSyncEnabled lewat destructuring saat modul dimuat.
//
// Aman dipakai lintas file: `node --test` menjalankan tiap file test di proses
// terpisah, sehingga tambalan ini tidak bocor ke test yang justru memverifikasi
// bahwa jeda berlaku (lihat customerSyncToggle.test.js).
const toggle = require('../src/lib/customerSyncToggle');

toggle.isCustomerSyncEnabled = () => true;

module.exports = { toggle };

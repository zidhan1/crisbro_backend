// Memusatkan normalisasi dan pencarian berbagai format nomor telepon agar seluruh proses autentikasi dan sinkronisasi konsisten serta mencegah kegagalan login akibat perbedaan format nomor.
function normalizePhone(raw) {
  if (!raw) return raw;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('62')) return digits.slice(2);
  if (digits.startsWith('0')) return digits.slice(1);
  return digits;
}

function phoneVariants(normalizedPhone) {
  if (!normalizedPhone) return [];

  return Array.from(
    new Set([normalizedPhone, `0${normalizedPhone}`, `62${normalizedPhone}`]),
  );
}

module.exports = { normalizePhone, phoneVariants };

const nodemailer = require('nodemailer');

const DEFAULT_FROM_EMAIL = 'it@crispybakar.biz';

function getMailerConfig() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  return {
    host,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: { user, pass },
  };
}

async function sendMail({ to, subject, text, html }) {
  const config = getMailerConfig();

  if (!config) {
    return {
      sent: false,
      skipped: true,
      reason: 'SMTP configuration is missing',
    };
  }

  const transporter = nodemailer.createTransport(config);
  const from = process.env.MAIL_FROM || DEFAULT_FROM_EMAIL;

  await transporter.sendMail({
    from,
    to,
    subject,
    text,
    html,
  });

  return { sent: true, skipped: false };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendActivationEmail({ to, customerName, activationUrl, expiresAt }) {
  const expiryText = new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Jakarta',
  }).format(expiresAt);
  const displayName = customerName || 'Customer Crisbar';
  const escapedName = escapeHtml(displayName);
  const escapedActivationUrl = escapeHtml(activationUrl);
  const escapedExpiryText = escapeHtml(expiryText);

  return sendMail({
    to,
    subject: 'Aktivasi Akun Crisbar',
    text: [
      `Halo ${displayName},`,
      '',
      'Akun Crisbar kamu sudah dibuat. Klik link berikut untuk mengaktifkan akun dan membuat password:',
      activationUrl,
      '',
      `Link ini hanya bisa dipakai satu kali dan berlaku sampai ${expiryText} WIB.`,
      '',
      'Jika kamu tidak merasa meminta akun ini, abaikan email ini.',
    ].join('\n'),
    html: `
      <p>Halo ${escapedName},</p>
      <p>Akun Crisbar kamu sudah dibuat. Klik tombol berikut untuk mengaktifkan akun dan membuat password:</p>
      <p>
        <a href="${escapedActivationUrl}" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#e11d48;color:#ffffff;text-decoration:none;font-weight:700;">
          Aktivasi Akun
        </a>
      </p>
      <p>Link ini hanya bisa dipakai satu kali dan berlaku sampai <strong>${escapedExpiryText} WIB</strong>.</p>
      <p>Jika tombol tidak bisa dibuka, salin link ini ke browser:</p>
      <p>${escapedActivationUrl}</p>
      <p>Jika kamu tidak merasa meminta akun ini, abaikan email ini.</p>
    `,
  });
}

module.exports = {
  sendActivationEmail,
  sendMail,
};

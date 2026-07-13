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

async function sendActivationEmail({
  to,
  customerName,
  phoneNumber,
  activationUrl,
  expiresAt,
}) {
  const expiryText = new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Jakarta',
  }).format(expiresAt);
  const displayName = customerName || 'Customer Crisbar';
  const loginIdText = phoneNumber ? `${to} / ${phoneNumber}` : to;
  const escapedName = escapeHtml(displayName);
  const escapedLoginId = escapeHtml(loginIdText);
  const escapedActivationUrl = escapeHtml(activationUrl);
  const escapedExpiryText = escapeHtml(expiryText);

  return sendMail({
    to,
    subject: 'Welcome to Loyalty Crisbro',
    text: [
      'Welcome to Loyalty Crisbro',
      '',
      `Hello ${displayName},`,
      '',
      'A new account has been created for you at https://crisbro-frontend.vercel.app/',
      `Your login ID is: ${loginIdText}`,
      '',
      'Click on the link below to complete your registration and set a new password.',
      activationUrl,
      '',
      'You can also copy-paste the following link in your browser:',
      activationUrl,
      '',
      `This link can only be used once and is valid until ${expiryText} WIB.`,
      '',
      'If you did not expect this account, please ignore this email.',
    ].join('\n'),
    html: `
      <h2 style="margin:0 0 16px;font-family:Arial,sans-serif;color:#111827;">Welcome to Loyalty Crisbro</h2>
      <p style="font-family:Arial,sans-serif;color:#374151;">Hello ${escapedName},</p>
      <p style="font-family:Arial,sans-serif;color:#374151;">
        A new account has been created for you at
        <a href="https://crisbro-frontend.vercel.app/" style="color:#e11d48;">https://crisbro-frontend.vercel.app/</a>
      </p>
      <p style="font-family:Arial,sans-serif;color:#374151;">
        Your login ID is: <strong>${escapedLoginId}</strong>
      </p>
      <p style="font-family:Arial,sans-serif;color:#374151;">
        Click on the link below to complete your registration and set a new password.
      </p>
      <p>
        <a href="${escapedActivationUrl}" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#e11d48;color:#ffffff;text-decoration:none;font-weight:700;">
          Complete Registration
        </a>
      </p>
      <p style="font-family:Arial,sans-serif;color:#374151;">
        You can also copy-paste the following link in your browser:
      </p>
      <p style="font-family:Arial,sans-serif;color:#374151;word-break:break-all;">${escapedActivationUrl}</p>
      <p style="font-family:Arial,sans-serif;color:#6b7280;font-size:13px;">
        This link can only be used once and is valid until <strong>${escapedExpiryText} WIB</strong>.
      </p>
      <p style="font-family:Arial,sans-serif;color:#6b7280;font-size:13px;">
        If you did not expect this account, please ignore this email.
      </p>
    `,
  });
}

module.exports = {
  sendActivationEmail,
  sendMail,
};

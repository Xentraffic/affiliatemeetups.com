const fs = require('fs');
const path = require('path');

// Transactional email is not chosen yet. The default writes to a local log.
// Brevo is not a supported mode.
async function sendMail({ to, subject, text }) {
  const mode = (process.env.EMAIL_MODE || 'log').toLowerCase();
  if (mode === 'brevo') {
    throw new Error('EMAIL_MODE=brevo is not supported');
  }
  if (mode === 'smtp') {
    if (!process.env.SMTP_HOST || !process.env.SMTP_FROM) {
      return logMail({ to, subject, text, note: 'smtp requested but SMTP_HOST or SMTP_FROM is unset' });
    }
    let nodemailer;
    try {
      nodemailer = require('nodemailer');
    } catch {
      return logMail({ to, subject, text, note: 'smtp requested but nodemailer is not installed' });
    }
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === '1',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
    });
    await transport.sendMail({ from: process.env.SMTP_FROM, to, subject, text });
    return { mode: 'smtp', delivered: true };
  }
  return logMail({ to, subject, text });
}

function logMail({ to, subject, text, note }) {
  const file = process.env.EMAIL_LOG_PATH || path.join(__dirname, 'mail-outbox.log');
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), to, subject, text, note: note || null });
  fs.appendFileSync(file, `${line}\n`);
  try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
  return { mode: 'log', delivered: false };
}

module.exports = { sendMail };

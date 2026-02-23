import nodemailer from 'nodemailer';

let transporter = null;

export function initEmail() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    console.warn('[Email] SMTP not configured. Email sending disabled.');
    return false;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  transporter.verify().then(() => {
    console.log('[Email] SMTP connected');
  }).catch((err) => {
    console.error('[Email] SMTP connection failed:', err.message);
  });

  return true;
}

export async function sendVerificationCode(email, code) {
  if (!transporter) {
    console.warn('[Email] Cannot send — SMTP not configured');
    return false;
  }

  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  await transporter.sendMail({
    from,
    to: email,
    subject: 'Remote Clauding — Verification Code',
    text: `Your verification code is: ${code}\n\nThis code expires in 15 minutes.`,
    html: `
      <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #d97757;">Remote Clauding</h2>
        <p>Your verification code is:</p>
        <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; text-align: center; padding: 20px; background: #f5f5f5; border-radius: 8px; margin: 16px 0;">
          ${code}
        </div>
        <p style="color: #666; font-size: 14px;">This code expires in 15 minutes.</p>
      </div>
    `,
  });

  console.log(`[Email] Verification code sent to ${email}`);
  return true;
}

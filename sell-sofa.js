import Busboy from 'busboy';
import nodemailer from 'nodemailer';

const MAX_FILES = 8;
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);
const ALLOWED_EXT = /\.(jpe?g|png|webp|heic|heif)$/i;

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = [];
    const pending = [];

    const busboy = Busboy({
      headers: req.headers,
      limits: {
        files: MAX_FILES,
        fileSize: MAX_FILE_SIZE,
      },
    });

    busboy.on('field', (name, value) => {
      fields[name] = value;
    });

    busboy.on('file', (name, stream, info) => {
      const chunks = [];
      let truncated = false;

      const done = new Promise((fileResolve) => {
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('limit', () => {
          truncated = true;
          stream.resume();
        });
        stream.on('end', () => {
          if (!truncated && chunks.length) {
            files.push({
              fieldname: name,
              filename: info.filename || `bild-${files.length + 1}.jpg`,
              mimeType: info.mimeType || 'application/octet-stream',
              buffer: Buffer.concat(chunks),
            });
          }
          fileResolve();
        });
      });

      pending.push(done);
    });

    busboy.on('error', reject);
    busboy.on('finish', async () => {
      try {
        await Promise.all(pending);
        resolve({ fields, files });
      } catch (error) {
        reject(error);
      }
    });

    req.pipe(busboy);
  });
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidPostcode(value) {
  return /^\d{5}$/.test(value);
}

function isAllowedImage(file) {
  const mime = (file.mimeType || '').toLowerCase();
  const name = file.filename || '';
  return ALLOWED_MIMES.has(mime) || ALLOWED_EXT.test(name);
}

function validateSubmission({ fields, files }) {
  if ((fields.website || '').trim()) {
    return { spam: true };
  }

  const errors = [];
  const soffa = (fields.soffa || fields.titel || '').trim();
  const skick = (fields.skick || '').trim();
  const plats = (fields.plats || '').trim().replace(/\s/g, '');
  const ort = (fields.ort || '').trim();
  const name = (fields.name || '').trim();
  const email = (fields.email || '').trim();
  const phone = (fields.phone || '').trim();

  if (!soffa) errors.push('Beskriv soffan.');
  if (!skick) errors.push('Välj skick.');
  if (!plats || !isValidPostcode(plats)) errors.push('Ange ett giltigt postnummer (5 siffror).');
  if (!name) errors.push('Ange ditt namn.');
  if (!email || !isValidEmail(email)) errors.push('Ange en giltig e-postadress.');

  const validFiles = files.filter(isAllowedImage);
  if (!validFiles.length) {
    errors.push('Ladda upp minst en bild (jpg, png, webp eller heic).');
  }
  if (files.length > MAX_FILES) {
    errors.push(`Max ${MAX_FILES} bilder tillåtna.`);
  }

  if (errors.length) {
    return { error: errors.join(' ') };
  }

  return {
    data: {
      soffa,
      skick,
      plats,
      ort,
      name,
      email,
      phone,
      files: validFiles,
    },
  };
}

function buildEmailText(data) {
  const lines = [
    'Ny förfrågan: Sälj din soffa',
    '================================',
    '',
    `Soffa: ${data.soffa}`,
    `Skick: ${data.skick}`,
    `Plats: ${data.plats}${data.ort ? ` ${data.ort}` : ''}`,
    '',
    'Kontakt',
    '-------',
    `Namn: ${data.name}`,
    `E-post: ${data.email}`,
  ];

  if (data.phone) lines.push(`Telefon: ${data.phone}`);

  lines.push('');
  lines.push(`Antal bifogade bilder: ${data.files.length}`);
  lines.push('');
  lines.push('Skickat via soffexpert.se');

  return lines.join('\n');
}

async function sendViaResend({ to, from, subject, text, attachments }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
      attachments: attachments.map((file) => ({
        filename: file.filename,
        content: file.buffer.toString('base64'),
      })),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Resend-fel: ${body || response.statusText}`);
  }
}

async function sendViaSmtp({ to, from, subject, text, attachments }) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error('E-post är inte konfigurerad (SMTP eller Resend).');
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  await transporter.sendMail({
    from,
    to,
    subject,
    text,
    attachments: attachments.map((file) => ({
      filename: file.filename,
      content: file.buffer,
      contentType: file.mimeType,
    })),
  });
}

async function sendSellSofaEmail(data) {
  const to = process.env.SELL_SOFA_EMAIL_TO || 'support@soffexpert.se';
  const from =
    process.env.SMTP_FROM ||
    process.env.RESEND_FROM ||
    'Soffexpert <noreply@soffexpert.se>';
  const subject = `Sälj soffa: ${data.soffa.slice(0, 50)} (${data.plats})`;
  const text = buildEmailText(data);

  if (process.env.RESEND_API_KEY) {
    await sendViaResend({ to, from, subject, text, attachments: data.files });
    return;
  }

  await sendViaSmtp({ to, from, subject, text, attachments: data.files });
}

export async function handleSellSofa(req) {
  const { fields, files } = await parseMultipart(req);
  const result = validateSubmission({ fields, files });

  if (result.spam) {
    return { success: true };
  }

  if (result.error) {
    return { error: result.error };
  }

  await sendSellSofaEmail(result.data);
  return { success: true };
}

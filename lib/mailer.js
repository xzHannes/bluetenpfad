'use strict';
/*
 * Blütenpfad — minimaler, dependency-freier SMTP-Mailer.
 * ------------------------------------------------------
 * Nutzt nur Node-Built-ins (net/tls). Unterstützt:
 *   - implizites TLS (Port 465, SMTP_SECURE=1)
 *   - STARTTLS (Port 587)
 *   - AUTH LOGIN und AUTH PLAIN
 *
 * Konfiguration komplett über ENV (Secrets gehören in die systemd-Unit,
 * nie ins Repo):
 *   SMTP_HOST      Mailserver-Host (z. B. mail.dein-provider.de)
 *   SMTP_PORT      Port (Default 587; 465 → implizites TLS)
 *   SMTP_SECURE    "1"/"true" → implizites TLS erzwingen (sonst aus Port abgeleitet)
 *   SMTP_USER      Login (meist die Absender-Adresse)
 *   SMTP_PASS      Passwort / App-Passwort
 *   MAIL_FROM      Absender, z. B. 'Blütenpfad <noreply@bluetenpfad.de>'
 *
 * Ist SMTP_HOST nicht gesetzt, gilt der Mailer als "nicht konfiguriert":
 * sendMail() wirft nicht, sondern signalisiert dem Aufrufer, dass nichts
 * verschickt wurde (→ Dev-Fallback: Link wird geloggt/zurückgegeben).
 */

const net = require('net');
const tls = require('tls');
const https = require('https');

const HOST = process.env.SMTP_HOST || '';
const PORT = Number(process.env.SMTP_PORT || 587);
const SECURE = process.env.SMTP_SECURE === '1' || process.env.SMTP_SECURE === 'true' || PORT === 465;
const USER = process.env.SMTP_USER || '';
const PASS = process.env.SMTP_PASS || '';
const FROM = process.env.MAIL_FROM || (USER ? `Blütenpfad <${USER}>` : 'Blütenpfad <noreply@bluetenpfad.de>');

// Brevo-REST-API-Key (Port 443). Wird gegenüber SMTP bevorzugt — nötig auf Hostern
// wie Netcup, die ausgehende SMTP-Ports (25/465/587) blockieren. Versand dann über
// https://api.brevo.com statt direktem Mailserver-Dialog.
const API_KEY = process.env.BREVO_API_KEY || '';

// Konfiguriert, sobald ENTWEDER ein Brevo-API-Key ODER ein SMTP-Host gesetzt ist.
const isConfigured = () => !!API_KEY || !!HOST;

// ── SMTP-Konversation ──────────────────────────────────────────
// Liest eine vollständige SMTP-Antwort (mehrzeilig möglich: "250-..." Fortsetzung,
// "250 ..." Abschluss) und prüft auf erwarteten Statuscode.
function smtpDialog(socket) {
  let buffer = '';
  let waiter = null;

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    tryResolve();
  });

  function completeResponse() {
    // Eine Antwort ist komplett, wenn eine Zeile auf "<code> " (Space nach 3 Ziffern) endet.
    const lines = buffer.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\d{3} /.test(l)) {
        const consumed = lines.slice(0, i + 1).join('\r\n');
        const code = Number(l.slice(0, 3));
        return { code, text: consumed, rest: buffer.slice(consumed.length).replace(/^\r?\n/, '') };
      }
    }
    return null;
  }

  function tryResolve() {
    if (!waiter) return;
    const r = completeResponse();
    if (r) {
      buffer = r.rest;
      const w = waiter; waiter = null;
      w.resolve({ code: r.code, text: r.text });
    }
  }

  function read() {
    return new Promise((resolve, reject) => {
      waiter = { resolve, reject };
      tryResolve();
    });
  }

  function write(line) {
    return new Promise((resolve, reject) => {
      socket.write(line + '\r\n', (err) => (err ? reject(err) : resolve()));
    });
  }

  async function cmd(line, expect) {
    await write(line);
    const res = await read();
    if (expect && !expect.includes(res.code)) {
      throw new Error(`SMTP ${line.split(' ')[0]} → ${res.code}: ${res.text.trim()}`);
    }
    return res;
  }

  return { read, write, cmd, getBuffer: () => buffer };
}

function connectPlain(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    sock.once('error', reject);
    sock.once('connect', () => { sock.removeListener('error', reject); resolve(sock); });
  });
}
function upgradeTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host }, () => {
      secure.removeListener('error', reject);
      resolve(secure);
    });
    secure.once('error', reject);
  });
}
function connectTls(host, port) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, servername: host }, () => {
      sock.removeListener('error', reject);
      resolve(sock);
    });
    sock.once('error', reject);
  });
}

function buildMessage({ to, subject, text, html }) {
  const boundary = 'bp_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const enc = (s) => `=?UTF-8?B?${Buffer.from(String(s), 'utf8').toString('base64')}?=`;
  const headers = [
    `From: ${FROM}`,
    `To: ${to}`,
    `Subject: ${enc(subject)}`,
    `MIME-Version: 1.0`,
    `Date: ${new Date().toUTCString()}`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text || '', 'utf8').toString('base64'),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html || text || '', 'utf8').toString('base64'),
    `--${boundary}--`,
    '',
  ];
  // Dot-Stuffing: Zeilen, die mit "." beginnen, im DATA-Body verdoppeln.
  const body = parts.join('\r\n').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
  return headers.join('\r\n') + '\r\n\r\n' + body;
}

function addrOnly(s) {
  const m = String(s).match(/<([^>]+)>/);
  return m ? m[1] : String(s).trim();
}

// Zerlegt MAIL_FROM ("Blütenpfad <noreply@…>") in {name, email} für die Brevo-API.
function senderFromFrom() {
  const email = addrOnly(FROM);
  const m = String(FROM).match(/^\s*"?([^"<]*?)"?\s*</);
  const name = m && m[1].trim() ? m[1].trim() : 'Blütenpfad';
  return { name, email };
}

// ── Versand über Brevos REST-API (Port 443) ────────────────────
// Wirft bei Fehler/Non-2xx (Aufrufer loggt), resolved true bei Erfolg.
function sendViaApi({ to, subject, text, html }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      sender: senderFromFrom(),
      to: [{ email: addrOnly(to) }],
      subject,
      htmlContent: html || text || '',
      textContent: text || '',
    });
    const req = https.request({
      method: 'POST',
      hostname: 'api.brevo.com',
      path: '/v3/smtp/email',
      headers: {
        'api-key': API_KEY,
        'content-type': 'application/json',
        'accept': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(true);
        else reject(new Error(`Brevo API ${res.statusCode}: ${body.slice(0, 300)}`));
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('Brevo API timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Versendet eine Mail. Gibt true zurück bei Versand, false wenn weder API noch SMTP
// konfiguriert ist (Aufrufer entscheidet dann über den Dev-Fallback).
async function sendMail({ to, subject, text, html }) {
  if (!isConfigured()) return false;

  // API-Key gesetzt → über HTTPS (umgeht SMTP-Port-Blocks z. B. bei Netcup).
  if (API_KEY) return sendViaApi({ to, subject, text, html });

  let socket = SECURE ? await connectTls(HOST, PORT) : await connectPlain(HOST, PORT);
  socket.setTimeout(15000, () => socket.destroy(new Error('SMTP timeout')));

  try {
    let dlg = smtpDialog(socket);
    const greeting = await dlg.read();
    if (greeting.code !== 220) throw new Error('SMTP greeting ' + greeting.code);

    const ehloHost = 'bluetenpfad.de';
    let ehlo = await dlg.cmd(`EHLO ${ehloHost}`, [250]);

    if (!SECURE && /STARTTLS/i.test(ehlo.text)) {
      await dlg.cmd('STARTTLS', [220]);
      socket = await upgradeTls(socket, HOST);
      socket.setTimeout(15000, () => socket.destroy(new Error('SMTP timeout')));
      dlg = smtpDialog(socket);
      ehlo = await dlg.cmd(`EHLO ${ehloHost}`, [250]);
    }

    if (USER && PASS) {
      if (/AUTH[ =-].*PLAIN/i.test(ehlo.text)) {
        const token = Buffer.from(` ${USER} ${PASS}`, 'utf8').toString('base64');
        await dlg.cmd(`AUTH PLAIN ${token}`, [235]);
      } else {
        await dlg.cmd('AUTH LOGIN', [334]);
        await dlg.cmd(Buffer.from(USER, 'utf8').toString('base64'), [334]);
        await dlg.cmd(Buffer.from(PASS, 'utf8').toString('base64'), [235]);
      }
    }

    await dlg.cmd(`MAIL FROM:<${addrOnly(FROM)}>`, [250]);
    await dlg.cmd(`RCPT TO:<${addrOnly(to)}>`, [250, 251]);
    await dlg.cmd('DATA', [354]);
    await dlg.write(buildMessage({ to, subject, text, html }));
    const sent = await dlg.cmd('.', [250]);
    try { await dlg.cmd('QUIT', [221]); } catch (_) {}
    socket.end();
    return sent.code === 250;
  } finally {
    try { socket.destroy(); } catch (_) {}
  }
}

// ── Verifizierungs-Mail im Blütenpfad-Stil ─────────────────────
function verificationEmail(name, url) {
  const safeName = String(name || 'Naturfreund:in');
  const text = [
    `Hallo ${safeName},`,
    '',
    'schön, dass du bei Blütenpfad dabei bist! 🌱',
    'Bitte bestätige deine E-Mail-Adresse über diesen Link:',
    '',
    url,
    '',
    'Der Link ist 24 Stunden gültig. Wenn du dich nicht registriert hast,',
    'kannst du diese Mail einfach ignorieren.',
    '',
    'Bis bald draußen,',
    'dein Blütenpfad 🌸',
  ].join('\n');

  const html = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"></head>
<body style="margin:0;padding:0;background:#eee2c6;-webkit-text-size-adjust:100%;font-family:'Nunito','Segoe UI',Helvetica,Arial,sans-serif;color:#45422f">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">Nur noch ein Klick — dann beginnt dein Natur-Dex. 🌿</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eee2c6"><tr><td align="center" style="padding:30px 16px">

  <table role="presentation" width="460" cellpadding="0" cellspacing="0" style="width:460px;max-width:460px;background:#fffef9;border:1px solid #e4d4aa;border-radius:26px;overflow:hidden;box-shadow:0 14px 34px rgba(99,86,40,.18)">

    <tr><td bgcolor="#74a945" style="background:#74a945;background:linear-gradient(150deg,#9ccd6e 0%,#6ba23d 100%);padding:30px 28px 26px;text-align:center">
      <div style="font-family:'Nunito',Helvetica,Arial,sans-serif;font-size:11px;letter-spacing:3px;font-weight:700;color:#eaf6d6;text-transform:uppercase">&#10022;&nbsp;&nbsp;Naturpost&nbsp;&nbsp;&#10022;</div>
      <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:14px auto 12px"><tr><td width="78" height="78" align="center" valign="middle" style="width:78px;height:78px;background:#fffef9;border:3px solid #d8ecbf;border-radius:50%;box-shadow:0 4px 0 rgba(60,90,30,.22);font-size:40px;line-height:78px">🌼</td></tr></table>
      <div style="font-family:'Fredoka','Trebuchet MS',Verdana,sans-serif;font-size:26px;font-weight:700;color:#ffffff;text-shadow:0 1px 0 rgba(54,82,26,.45)">Blütenpfad</div>
      <div style="font-family:'Nunito',Helvetica,Arial,sans-serif;font-size:12.5px;color:#eef7e0;letter-spacing:.5px">dein Natur-Dex</div>
    </td></tr>

    <tr><td style="padding:0;line-height:0;font-size:0;border-top:2px dashed #e7d7ad;height:2px">&nbsp;</td></tr>

    <tr><td style="padding:28px 32px 6px">
      <p style="margin:0 0 14px;font-family:'Fredoka','Trebuchet MS',Verdana,sans-serif;font-size:19px;color:#3f5c27">Hallo ${escapeHtml(safeName)}! 🌱</p>
      <p style="margin:0;font-size:15.5px;line-height:1.62;color:#56523c">Schön, dass du dabei bist. Bestätige kurz deine E-Mail-Adresse — dann öffnet sich dein Natur-Dex und das Sammeln kann losgehen.</p>
    </td></tr>

    <tr><td align="center" style="padding:18px 32px 6px">
      <a href="${escapeHtml(url)}" style="display:inline-block;background:#74a945;background:linear-gradient(180deg,#a4d178 0%,#73a843 100%);color:#ffffff;font-family:'Fredoka','Trebuchet MS',Verdana,sans-serif;font-weight:600;font-size:16.5px;text-decoration:none;padding:15px 34px;border-radius:22px;box-shadow:0 4px 0 #4f7a2e">🌿&nbsp;&nbsp;E-Mail bestätigen</a>
    </td></tr>

    <tr><td align="center" style="padding:14px 32px 4px">
      <span style="display:inline-block;background:#f1f7e6;border:1px solid #dcebc6;border-radius:999px;padding:6px 14px;font-size:12.5px;color:#5f7a40">&#9203; Link 24 Stunden gültig</span>
    </td></tr>

    <tr><td style="padding:16px 32px 22px">
      <p style="margin:0;font-size:12px;line-height:1.55;color:#97916f">Button klemmt? Diesen Link in den Browser kopieren:<br><a href="${escapeHtml(url)}" style="color:#5f8a39;word-break:break-all;text-decoration:none">${escapeHtml(url)}</a></p>
    </td></tr>

    <tr><td style="padding:18px 28px 24px;border-top:1px solid #efe6cb;text-align:center;background:#fcf7e9">
      <div style="font-size:16px;letter-spacing:6px">🌿&nbsp;🍃&nbsp;🌱</div>
      <p style="margin:10px 0 2px;font-family:'Fredoka','Trebuchet MS',Verdana,sans-serif;font-size:13.5px;color:#7a8a5e">Bis bald draußen — dein Blütenpfad 🌸</p>
      <p style="margin:0;font-size:11px;color:#b1aa86">Nicht registriert? Dann ignorier diese Mail einfach.</p>
    </td></tr>

  </table>

  <p style="margin:14px 0 0;font-size:11px;color:#a59c78;font-family:'Nunito',Helvetica,Arial,sans-serif">bluetenpfad.de · dein cozy Natur-Dex</p>

</td></tr></table>
</body></html>`;

  return { subject: 'Bestätige deine E-Mail — Blütenpfad 🌱', text, html };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

module.exports = { sendMail, isConfigured, verificationEmail, FROM };

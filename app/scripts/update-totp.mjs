#!/usr/bin/env node
import crypto from 'node:crypto';
import readline from 'node:readline';
import { existsSync } from 'node:fs';
import qrcode from 'qrcode';
import Database from 'better-sqlite3';

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const CYAN   = '\x1b[36m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const DIM    = '\x1b[2m';
const YELLOW = '\x1b[33m';

const DB_PATH = process.env.PREFS_DB_PATH ?? '/app/prefs/mintlayer_prefs.sqlite';

// ── TOTP helpers (mirrors app/src/lib/auth.ts) ──────────────────────────────

function generateTotpSecret() {
  const bytes = crypto.randomBytes(20);
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let result = '', bits = 0, value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      result += alpha[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += alpha[(value << (5 - bits)) & 31];
  return result;
}

function decodeBase32(input) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const str = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of str) {
    const idx = alpha.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function hotpCode(key, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    (((hmac[offset] & 0x7f) << 24) |
     ((hmac[offset + 1] & 0xff) << 16) |
     ((hmac[offset + 2] & 0xff) << 8) |
     (hmac[offset + 3] & 0xff)) % 1_000_000;
  return code.toString().padStart(6, '0');
}

function verifyTOTP(code, secret) {
  if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) return false;
  const key = decodeBase32(secret);
  const T = BigInt(Math.floor(Date.now() / 1000 / 30));
  for (const delta of [-1n, 0n, 1n]) {
    const candidate = hotpCode(key, T + delta);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(code))) return true;
  }
  return false;
}

// ── Readline helper ──────────────────────────────────────────────────────────

function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${BOLD}${CYAN}┌─────────────────────────────────────────┐${RESET}`);
  console.log(`${BOLD}${CYAN}│   Mintlayer GUI — Update TOTP Secret    │${RESET}`);
  console.log(`${BOLD}${CYAN}└─────────────────────────────────────────┘${RESET}\n`);

  if (!existsSync(DB_PATH)) {
    console.error(`${RED}Error: database not found at ${DB_PATH}${RESET}`);
    console.error(`${DIM}Set PREFS_DB_PATH env var to point to mintlayer_prefs.sqlite${RESET}`);
    process.exit(1);
  }

  const secret = generateTotpSecret();
  const issuer = 'Mintlayer';
  const label  = encodeURIComponent('Mintlayer GUI');
  const uri    = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}`;

  // Render QR code
  const qr = await qrcode.toString(uri, { type: 'utf8', errorCorrectionLevel: 'M' });
  console.log(qr);

  console.log(`${BOLD}TOTP Secret (manual entry):${RESET}`);
  console.log(`  ${YELLOW}${BOLD}${secret}${RESET}\n`);
  console.log(`${DIM}otpauth URI:${RESET}`);
  console.log(`  ${DIM}${uri}${RESET}\n`);

  console.log(`${YELLOW}Scan the QR code with your authenticator app before continuing.${RESET}`);
  console.log(`${YELLOW}The current secret will be overwritten and cannot be recovered.${RESET}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let confirmed = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const code = (await prompt(rl, `${BOLD}Enter the 6-digit code from your authenticator: ${RESET}`)).trim();
    if (verifyTOTP(code, secret)) {
      confirmed = true;
      break;
    }
    console.log(`${RED}Invalid code.${attempt < 3 ? ` ${3 - attempt} attempt(s) remaining.` : ''}${RESET}`);
  }

  rl.close();

  if (!confirmed) {
    console.log(`\n${RED}Aborted — TOTP secret was NOT saved.${RESET}\n`);
    process.exit(1);
  }

  // Write to SQLite
  const db = new Database(DB_PATH);
  db.prepare("INSERT OR REPLACE INTO prefs (key, value) VALUES ('auth.totp_secret', ?)").run(JSON.stringify(secret));
  db.close();

  console.log(`\n${GREEN}${BOLD}✓ TOTP secret updated successfully.${RESET}`);
  console.log(`${DIM}Restart the web-gui container if it is currently running.${RESET}\n`);
}

main().catch(err => {
  console.error(`${RED}Fatal: ${err.message}${RESET}`);
  process.exit(1);
});

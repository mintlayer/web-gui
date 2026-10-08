#!/usr/bin/env node
// ⚠️  DEVELOPMENT TOOL — DO NOT USE IN PRODUCTION ⚠️
//
// This script exists ONLY for local development and scripted testing of the
// wallet's TOTP login (e.g. driving E2E flows against `make dev`). It prints
// live one-time codes from a base32 secret, which means anyone who can run it
// with the secret has the second factor. Real deployments must keep secrets
// in the user's authenticator app only.
//
// The secret is read interactively (hidden input) or from stdin — never from
// argv — so it stays out of shell history and process listings. Usage:
//
//   tools/totp.mjs                 # prompts for the secret (hidden)
//   printf '%s' "$SECRET" | tools/totp.mjs   # piped, also not in history
//
// Stdout carries only the 6-digit code (script-friendly); a validity hint
// goes to stderr. Algorithm matches app/src/lib/auth.ts (SHA-1, 30s, 6 digits).

import { createHmac } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECS = 30;

function decodeBase32(input) {
  const str = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of str) {
    const idx = BASE32.indexOf(char);
    if (idx === -1) continue; // skip invalid chars gracefully, as the app does
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(secretBase32, counter) {
  const key = decodeBase32(secretBase32);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      hmac[offset + 3]) %
    1_000_000;
  return code.toString().padStart(6, '0');
}

// Hidden prompt: raw-mode tty reader, with a plain stdin fallback for pipes.
function promptSecret() {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk) => (data += chunk));
      stdin.on('end', () => resolve(data.trim()));
      stdin.on('error', reject);
      return;
    }
    process.stderr.write('TOTP secret (input hidden): ');
    stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const finish = (value) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
      resolve(value);
    };
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') return finish(buf);
      if (ch === '\u0003') return finish(''); // Ctrl-C → empty = abort
      if (ch === '\u007f') buf = buf.slice(0, -1);
      else if (ch >= ' ') buf += ch;
    };
    stdin.on('data', onData);
  });
}

const secret = await promptSecret();
if (!secret) {
  console.error('no secret given');
  process.exit(1);
}

const counter = Math.floor(Date.now() / 1000 / STEP_SECS);
const remaining = STEP_SECS - Math.floor(Date.now() / 1000) % STEP_SECS;
console.log(totp(secret, counter));
console.error(`valid for ~${remaining}s (accepts the neighbouring window too)`);

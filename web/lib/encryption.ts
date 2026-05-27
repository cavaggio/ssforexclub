/**
 * web/lib/encryption.ts
 *
 * AES-256-GCM helpers for broker credentials.
 *
 * Format on disk:   <iv-hex>:<auth-tag-hex>:<ciphertext-hex>
 *
 * Why GCM and not CBC: GCM provides authenticated encryption — any tampering
 * with the ciphertext is detected on decrypt (the auth tag will fail). CBC
 * would let an attacker who can write to the DB silently mutate credentials.
 *
 * The ENCRYPTION_KEY env must be exactly 32 bytes (64 hex chars). Generate
 * one with:
 *
 *     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Rotating the key requires re-encrypting every row in broker_connections
 * with the new key — out of scope for the scaffolding phase.
 */

import 'server-only';
import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;       // standard for GCM
const KEY_LENGTH = 32;      // 256-bit

let _key: Buffer | null = null;

function getKey(): Buffer {
  if (_key) return _key;
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) throw new Error('ENCRYPTION_KEY env var is not set');
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error('ENCRYPTION_KEY must be a hex string');
  }
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== KEY_LENGTH) {
    throw new Error(
      `ENCRYPTION_KEY must decode to ${KEY_LENGTH} bytes (got ${buf.length}). ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }
  _key = buf;
  return _key;
}

export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encryptSecret: plaintext must be a non-empty string');
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

export function decryptSecret(payload: string): string {
  if (typeof payload !== 'string') {
    throw new Error('decryptSecret: payload must be a string');
  }
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('decryptSecret: malformed payload (expected iv:tag:ciphertext)');
  }
  const [ivHex, tagHex, ctHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

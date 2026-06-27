import crypto from "crypto";

// Encrypts Gmail refresh tokens at rest with AES-256-GCM. Format:
//   "v1:" + base64( iv(12) || authTag(16) || ciphertext )
// If TOKEN_ENCRYPTION_KEY is not set we fall back to plaintext so local dev
// keeps working — set the key in production. Existing plaintext tokens are read
// transparently (no "v1:" prefix => returned as-is).

const PREFIX = "v1:";

function getKey(): Buffer | null {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

export function encryptToken(plain: string): string {
  const key = getKey();
  if (!key) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptToken(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext
  const key = getKey();
  if (!key) {
    throw new Error("TOKEN_ENCRYPTION_KEY is required to read encrypted tokens");
  }
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

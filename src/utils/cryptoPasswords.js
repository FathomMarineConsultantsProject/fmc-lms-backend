// src/utils/cryptoPasswords.js
import crypto from "crypto";

/**
 * ENV REQUIRED:
 *   PASSWORD_ENC_KEY = 32-byte key in hex (64 hex chars) OR base64 (44 chars)
 *
 * Example (hex): 64 hex chars
 * Example (base64): 44 chars
 */

const getKey = () => {
  const raw = process.env.PASSWORD_ENC_KEY;
  if (!raw) throw new Error("PASSWORD_ENC_KEY missing in .env");

  // hex (64 chars => 32 bytes)
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");

  // base64 (typically 44 chars => 32 bytes)
  try {
    const b = Buffer.from(raw, "base64");
    if (b.length === 32) return b;
  } catch (_) {}

  throw new Error("PASSWORD_ENC_KEY must be 32 bytes (hex64 or base64-32bytes).");
};

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // recommended for GCM
const VERSION_PREFIX = "gcm:v1";

/**
 * Encrypt plain text -> "gcm:v1:iv:tag:cipher" (base64 parts)
 */
export const encryptPassword = (plain) => {
  if (plain === null || plain === undefined) return null;
  const text = String(plain);

  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);

  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${VERSION_PREFIX}:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
};

/**
 * Decrypt known formats:
 * 1) "gcm:v1:iv:tag:cipher"
 * 2) JSON string: {"iv":"..","tag":"..","content":".."} or {"iv","authTag","encrypted"}
 * 3) Simple "iv:tag:cipher" (base64 parts)  (legacy-ish)
 */
export const decryptPassword = (encrypted) => {
  if (!encrypted) return null;

  const key = getKey();
  const s = String(encrypted);

  // 1) Our canonical format
  if (s.startsWith(`${VERSION_PREFIX}:`)) {
    const parts = s.split(":");
    if (parts.length !== 5) throw new Error("Bad encrypted format (gcm:v1 parts).");
    const iv = Buffer.from(parts[2], "base64");
    const tag = Buffer.from(parts[3], "base64");
    const cipherBytes = Buffer.from(parts[4], "base64");

    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(cipherBytes), decipher.final()]);
    return plain.toString("utf8");
  }

  // 2) JSON legacy format
  if (s.trim().startsWith("{")) {
    const obj = JSON.parse(s);

    const ivB64 = obj.iv;
    const tagB64 = obj.tag || obj.authTag;
    const cipherB64 = obj.content || obj.encrypted || obj.ciphertext;

    if (!ivB64 || !tagB64 || !cipherB64) {
      throw new Error("Bad JSON encrypted format (missing iv/tag/content).");
    }

    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const cipherBytes = Buffer.from(cipherB64, "base64");

    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(cipherBytes), decipher.final()]);
    return plain.toString("utf8");
  }

  // 3) "iv:tag:cipher" base64 parts
  const parts = s.split(":");
  if (parts.length === 3) {
    const iv = Buffer.from(parts[0], "base64");
    const tag = Buffer.from(parts[1], "base64");
    const cipherBytes = Buffer.from(parts[2], "base64");

    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(cipherBytes), decipher.final()]);
    return plain.toString("utf8");
  }

  throw new Error("Unknown encrypted password format.");
};

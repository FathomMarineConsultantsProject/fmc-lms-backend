// src/utils/cryptoPasswords.js
import crypto from "crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;

const getEncKey = () => {
  const b64 = process.env.PASSWORD_ENC_KEY;
  if (!b64) throw new Error("PASSWORD_ENC_KEY missing in .env");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("PASSWORD_ENC_KEY must be 32 bytes base64");
  return key;
};

/**
 * Format stored in DB (your existing format):
 *   base64(iv).base64(tag).base64(ciphertext)
 */
export const encryptPassword = (plain) => {
  const key = getEncKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);

  const ciphertext = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`;
};

export const decryptPassword = (enc) => {
  if (!enc) return null;

  const key = getEncKey();
  const parts = String(enc).split(".");
  if (parts.length !== 3) throw new Error("Invalid password_enc format");

  const iv = Buffer.from(parts[0], "base64");
  const tag = Buffer.from(parts[1], "base64");
  const ciphertext = Buffer.from(parts[2], "base64");

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);

  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
};

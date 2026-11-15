// ---------------------------------------------------------------------------
// AES-256-GCM encryption for agent wallet private keys.
//
// The encryption key is derived from the AGENT_KEY_ENCRYPTION_SECRET env var
// via SHA-256, so the secret can be any length ≥ 32 chars. The output format
// is "iv:authTag:ciphertext" (all hex), which is safe to store in a string
// column and trivially parseable.
//
// WHY NOT PLAINTEXT
//   The agent private key signs real MUSD payments via x402. A database leak
//   (backup, log, compromised replica) would let anyone drain every agent
//   wallet. Encryption at rest means the attacker also needs the env secret,
//   which lives in a different system (PaaS secrets manager, .env file on
//   the gateway host).
// ---------------------------------------------------------------------------

import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits — GCM standard
const AUTH_TAG_LENGTH = 16; // 128 bits

function deriveKey(secret) {
  if (!secret || secret.length < 32) {
    throw new Error(
      "AGENT_KEY_ENCRYPTION_SECRET must be at least 32 characters. " +
      "Generate one with: openssl rand -base64 48"
    );
  }
  return crypto.createHash("sha256").update(secret).digest();
}

/**
 * Encrypt a hex private key (with or without 0x prefix).
 * @returns {string} "iv:authTag:ciphertext" — all hex, safe for MongoDB.
 */
export function encryptPrivateKey(plaintextHex) {
  const secret = process.env.AGENT_KEY_ENCRYPTION_SECRET;
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  // Strip 0x prefix if present — the key is stored as raw hex
  const raw = plaintextHex.startsWith("0x")
    ? plaintextHex.slice(2)
    : plaintextHex;

  const encrypted = Buffer.concat([
    cipher.update(raw, "hex"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypt a private key from the stored format.
 * @returns {string} "0x"-prefixed 66-char hex string, ready for viem/ethers.
 */
export function decryptPrivateKey(stored) {
  const secret = process.env.AGENT_KEY_ENCRYPTION_SECRET;
  const key = deriveKey(secret);

  const parts = stored.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted key format — expected iv:authTag:ciphertext");
  }

  const iv = Buffer.from(parts[0], "hex");
  const authTag = Buffer.from(parts[1], "hex");
  const ciphertext = Buffer.from(parts[2], "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return `0x${decrypted.toString("hex")}`;
}
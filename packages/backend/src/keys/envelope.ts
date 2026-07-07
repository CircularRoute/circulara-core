/**
 * WS2 - envelope encryption for BYO customer provider keys (D4).
 *
 * Scheme: AES-256-GCM. Each secret gets its own random DEK; the DEK is
 * wrapped by the master KEK (CIRCULARA_MASTER_KEY, hex, loaded ONLY via
 * loadSecret() from the external env file - never hardcoded, never logged).
 * Stored blob = wrap(DEK) || iv || tag || ciphertext, all base64 fields.
 *
 * Rotation: re-wrap DEKs under a new KEK without touching ciphertexts.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

export interface EnvelopeBlob {
  v: 1;
  wrapped_dek: string; // base64: iv || tag || enc(DEK) under KEK
  iv: string; // base64, data iv
  tag: string; // base64, data auth tag
  ct: string; // base64, ciphertext
}

function aesEncrypt(key: Buffer, plaintext: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ct };
}

function aesDecrypt(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export function parseKek(hex: string): Buffer {
  const kek = Buffer.from(hex.trim(), "hex");
  if (kek.length !== 32)
    throw new Error("CIRCULARA_MASTER_KEY must be 32 bytes hex (64 chars)");
  return kek;
}

export function envelopeEncrypt(kek: Buffer, secret: string): EnvelopeBlob {
  const dek = randomBytes(32);
  const data = aesEncrypt(dek, Buffer.from(secret, "utf8"));
  const wrap = aesEncrypt(kek, dek);
  return {
    v: 1,
    wrapped_dek: Buffer.concat([wrap.iv, wrap.tag, wrap.ct]).toString("base64"),
    iv: data.iv.toString("base64"),
    tag: data.tag.toString("base64"),
    ct: data.ct.toString("base64"),
  };
}

export function envelopeDecrypt(kek: Buffer, blob: EnvelopeBlob): string {
  const w = Buffer.from(blob.wrapped_dek, "base64");
  const dek = aesDecrypt(kek, w.subarray(0, 12), w.subarray(12, 28), w.subarray(28));
  return aesDecrypt(
    dek,
    Buffer.from(blob.iv, "base64"),
    Buffer.from(blob.tag, "base64"),
    Buffer.from(blob.ct, "base64"),
  ).toString("utf8");
}

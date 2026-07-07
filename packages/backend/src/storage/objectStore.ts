/**
 * Object storage for asset bytes: content-addressed by sha256 (the key IS the
 * checksum - AD8's Commons uses the same convention).
 *
 * Dev driver: filesystem under {dataDir}/objects/{tenantId}/.
 * Prod driver: S3-class, per-tenant bucket/prefix - stub until infra exists
 * (standing up paid cloud infra needs founder approval).
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface ObjectStore {
  /** Store bytes; returns the sha256 content address. */
  put(tenantId: string, bytes: Buffer): Promise<string>;
  get(tenantId: string, sha256: string): Promise<Buffer | null>;
  has(tenantId: string, sha256: string): Promise<boolean>;
}

export function sha256hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class FsObjectStore implements ObjectStore {
  constructor(private root: string) {}

  private pathFor(tenantId: string, key: string): string {
    // two-level fanout, git-style
    return join(this.root, tenantId, key.slice(0, 2), key.slice(2));
  }

  async put(tenantId: string, bytes: Buffer): Promise<string> {
    const key = sha256hex(bytes);
    const p = this.pathFor(tenantId, key);
    mkdirSync(join(p, ".."), { recursive: true });
    if (!existsSync(p)) writeFileSync(p, bytes); // content-addressed => immutable
    return key;
  }

  async get(tenantId: string, key: string): Promise<Buffer | null> {
    const p = this.pathFor(tenantId, key);
    if (!existsSync(p)) return null;
    const bytes = readFileSync(p);
    if (sha256hex(bytes) !== key) throw new Error(`integrity failure for ${key}`);
    return bytes;
  }

  async has(tenantId: string, key: string): Promise<boolean> {
    return existsSync(this.pathFor(tenantId, key));
  }
}

export class S3ObjectStore implements ObjectStore {
  // WS0 stub. Wiring a real bucket is prod infra -> founder approval first.
  put(): Promise<string> {
    throw new Error("S3 driver not configured in sprint 1 (dev uses FsObjectStore)");
  }
  get(): Promise<Buffer | null> {
    throw new Error("S3 driver not configured in sprint 1 (dev uses FsObjectStore)");
  }
  has(): Promise<boolean> {
    throw new Error("S3 driver not configured in sprint 1 (dev uses FsObjectStore)");
  }
}

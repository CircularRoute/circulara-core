/**
 * Runtime configuration.
 *
 * API keys live in ONE env file OUTSIDE the project (see /context/api.md).
 * Only the file PATH appears here. Values are loaded at runtime, held in
 * memory, and NEVER logged, echoed, or written anywhere.
 *
 * Sprint 1 (WS0/WS6) needs no live keys: Observe smoke tests are key-free.
 * The loader exists so WS2+ (BYO-key wiring) has one blessed entry point.
 */
import { readFileSync, existsSync } from "node:fs";

const DEFAULT_ENV_FILE =
  "/Users/rashadabbasov/Desktop/Claude Playground/greenlight.env";

export interface Config {
  envFilePath: string;
  dataDir: string; // root for control-plane db, tenant dbs, object storage
  port: number;
}

export function loadConfig(): Config {
  return {
    envFilePath: process.env.CIRCULARA_ENV_FILE ?? DEFAULT_ENV_FILE,
    dataDir: process.env.CIRCULARA_DATA_DIR ?? "./data",
    // B3: Render routes to $PORT; keep CIRCULARA_PORT for local, default 8787.
    port: Number(process.env.PORT ?? process.env.CIRCULARA_PORT ?? 8787),
  };
}

/**
 * Parse KEY=VALUE lines from the external env file. Returns only the keys
 * requested; never the whole map, never logged. Missing file or key -> null
 * (callers must handle absence; never prompt for a key inside code).
 */
export function loadSecret(cfg: Config, keyName: string): string | null {
  // B4: on Render there is no env FILE - secrets come from process.env. The
  // file (local dev) takes precedence; process.env is the fallback.
  if (existsSync(cfg.envFilePath)) {
    const lines = readFileSync(cfg.envFilePath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      if (trimmed.slice(0, eq).trim() === keyName) return trimmed.slice(eq + 1).trim();
    }
  }
  return process.env[keyName] ?? null;
}

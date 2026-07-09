/**
 * builder.20260708.002 - Path A packaging (CTO runbook section 3).
 * Bundle the plugin bins to dist/*.js so `@circulara/plugin` is installable
 * self-serve (`npx -y -p @circulara/plugin circulara-mcp`) without a repo clone
 * and without tsx at runtime.
 *
 *  - @circulara/schema (an UNPUBLISHED workspace sibling) is INLINED into the
 *    artifact so a plain npx install can resolve it.
 *  - @modelcontextprotocol/sdk and zod stay EXTERNAL (real npm deps that resolve
 *    at install), so the bundle stays small and their native/peer wiring is intact.
 *  - Every bin gets a plain `#!/usr/bin/env node` shebang (replaces the fragile
 *    `#!/usr/bin/env npx tsx` shebang that failed to exec on Linux).
 */
import { build } from "esbuild";

await build({
  entryPoints: ["src/server.ts", "src/hook.ts", "src/hook-pre.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  // resolve + inline @circulara/schema; keep the real npm deps external
  external: ["@modelcontextprotocol/sdk", "zod"],
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});

console.log("built dist/server.js, dist/hook.js, dist/hook-pre.js");

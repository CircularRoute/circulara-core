/**
 * builder.20260709.001 - build the backend to dist/main.js so production runs
 * compiled JS on plain `node` (no tsx resident as an in-process transpiler,
 * ~the other 512MB boot hog besides eager PGlite).
 *
 * Strategy: bundle our own source + the unpublished @circulara/* workspace
 * packages (TypeScript, cannot be resolved by node at runtime); keep every real
 * node_modules dependency EXTERNAL so it resolves normally at runtime -
 * critically the WASM deps (@electric-sql/pglite, pglite-pgvector) are NOT
 * bundled, and because tenancy.ts now imports them dynamically they never load
 * on the prod Postgres path. fastify / pg / jose / zod also resolve at runtime.
 */
import { build } from "esbuild";

/** Externalize node_modules (bare, non-@circulara) + node: builtins; bundle
 * relative imports and the @circulara/* workspace packages. */
const externalizeRuntimeDeps = {
  name: "externalize-runtime-deps",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === "entry-point") return;
      const p = args.path;
      if (p.startsWith(".") || p.startsWith("/")) return; // our source -> bundle
      if (p.startsWith("@circulara/")) return; // unpublished workspace TS -> bundle
      return { external: true }; // node_modules + node: builtins -> resolve at runtime
    });
  },
};

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  plugins: [externalizeRuntimeDeps],
  logLevel: "info",
});

console.log("built dist/main.js");

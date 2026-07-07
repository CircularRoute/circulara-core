/** Dev entrypoint: on-disk PGlite under ./data, Fs object store. */
import { loadConfig } from "./config.js";
import { ControlPlane } from "./db/tenancy.js";
import { FsObjectStore } from "./storage/objectStore.js";
import { buildApp } from "./api/server.js";
import { join } from "node:path";

const cfg = loadConfig();
const control = new ControlPlane(cfg.dataDir);
await control.init();
const app = buildApp({
  control,
  objects: new FsObjectStore(join(cfg.dataDir, "objects")),
});
await app.listen({ port: cfg.port, host: "127.0.0.1" });
console.log(`circulara-core listening on 127.0.0.1:${cfg.port}`);

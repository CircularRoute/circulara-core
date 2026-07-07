/**
 * Wave 5 - exact fingerprints (§6.2): deterministic content addresses for the
 * v1 launch asset classes. Identical config -> identical fingerprint; any
 * changed input -> different fingerprint. No similarity ambiguity, ever.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "../recycle/toolcache.js";
import { bucketWindow, type Bucket } from "../recycle/toolcache.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Asset class #1 - embedding index (§5): deterministic given the config. */
export interface EmbeddingIndexSpec {
  asset_type: 1;
  corpus_id: string;
  corpus_version: string; // content hash or version tag of the corpus
  chunking_scheme: string; // e.g. "fixed-512-overlap-64"
  embedding_model_id: string;
  dimensions: number;
  normalization: string; // e.g. "l2" | "none"
}

/** Asset class #2 - parsed/extracted document: same file + pipeline = same output. */
export interface ParsedDocSpec {
  asset_type: 2;
  source_checksum: string; // sha256 of the source file bytes
  pipeline: string; // e.g. "pdf-to-md"
  pipeline_version: string;
}

/** Asset class #3 - deterministic tool result: exact args + freshness bucket. */
export interface ToolResultSpec {
  asset_type: 3;
  canonical_source_id: string; // tool/endpoint identity
  params: unknown; // normalized query params
  schema_version: string;
  freshness_bucket: Bucket;
}

export type AssetSpec = EmbeddingIndexSpec | ParsedDocSpec | ToolResultSpec;

export function exactFingerprint(spec: AssetSpec, now = new Date()): string {
  switch (spec.asset_type) {
    case 1:
      return sha(
        `emb ${spec.corpus_id} ${spec.corpus_version} ${spec.chunking_scheme} ${spec.embedding_model_id} ${spec.dimensions} ${spec.normalization}`,
      );
    case 2:
      return sha(`doc ${spec.source_checksum} ${spec.pipeline} ${spec.pipeline_version}`);
    case 3:
      return sha(
        `tool ${spec.canonical_source_id} ${canonicalJson(spec.params)} ${spec.schema_version} ${bucketWindow(spec.freshness_bucket, now)}`,
      );
  }
}

/** Human-readable description used for the semantic fingerprint embedding. */
export function describeSpec(spec: AssetSpec): string {
  switch (spec.asset_type) {
    case 1:
      return `embedding index of corpus ${spec.corpus_id} v${spec.corpus_version}, chunks ${spec.chunking_scheme}, model ${spec.embedding_model_id} (${spec.dimensions}d, ${spec.normalization})`;
    case 2:
      return `parsed document ${spec.source_checksum.slice(0, 12)} via ${spec.pipeline} v${spec.pipeline_version}`;
    case 3:
      return `deterministic tool result from ${spec.canonical_source_id} params ${canonicalJson(spec.params)} schema ${spec.schema_version}`;
  }
}

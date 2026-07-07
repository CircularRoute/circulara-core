/**
 * Wave 4 - embedding port for the semantic cache layer. Runs on the
 * CUSTOMER's OpenAI key (D4, BYO): if the tenant has no openai key configured
 * the semantic layer is silently unavailable (exact-only still serves).
 */
import type { EmbedderPort } from "./responseCache.js";

export const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
export const EMBEDDING_MODEL = "text-embedding-3-small"; // 1536-dim, cheapest

export function makeOpenAIEmbedder(apiKey: string): EmbedderPort {
  return async (text: string) => {
    const res = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text.slice(0, 8000) }),
    });
    if (!res.ok) throw new Error(`embedding call failed: ${res.status}`);
    const j = (await res.json()) as { data: { embedding: number[] }[] };
    return j.data[0].embedding;
  };
}

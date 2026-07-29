import type http from "node:http";
import type { SearchInterpretation } from "../../../shared/filter-contract/src/index.ts";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { interpretSearchQuery } from "../naturalLanguageSearch/interpretSearchQuery.ts";
import { loadSearchVocabulary } from "../naturalLanguageSearch/searchVocabulary.ts";
import { ollamaUrl } from "../shareDescription/ollamaGenerate.ts";
import { getLogger } from "../observability/logger.ts";
import { writeJson } from "../utils.ts";

const log = getLogger("searchInterpretHandler");

const MAX_BODY_BYTES = 4 * 1024;

// Identical queries are common — a re-submit, a shared link, the same phrase
// typed again after browsing — and each miss costs an LLM round-trip. The key
// includes the UTC day because relative intents ("last summer") resolve against
// request time, so an entry must not outlive the day it was resolved on.
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const cache = new Map<string, { value: SearchInterpretation; at: number }>();

/** Test seam. */
export const clearSearchInterpretationCache = () => cache.clear();

const cacheKey = (query: string, now: number) =>
  `${new Date(now).toISOString().slice(0, 10)}|${query.trim().toLowerCase()}`;

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });

/**
 * POST /api/search/interpret — turn a natural-language query into structured
 * filters.
 *
 * Always answers 200 with a `SearchInterpretation`: `interpreted: false` covers
 * every degraded path (no Ollama configured, model down or slow, unusable
 * answer), because the client's fallback for all of them is the same — run the
 * query as the plain semantic search it already started.
 */
export const searchInterpretHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  { database }: { database: IndexDatabase },
): Promise<void> => {
  let body: { q?: unknown };
  try {
    body = JSON.parse(await readBody(req)) as { q?: unknown };
  } catch {
    writeJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  const query = typeof body.q === "string" ? body.q.trim() : "";
  if (!query) {
    writeJson(res, 200, { interpreted: false, reason: "empty-query" });
    return;
  }

  // No local model configured: answer immediately rather than making every
  // search wait out a connection attempt to nothing.
  if (!ollamaUrl) {
    writeJson(res, 200, { interpreted: false, reason: "disabled" });
    return;
  }

  const now = Date.now();
  const key = cacheKey(query, now);
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    writeJson(res, 200, hit.value);
    return;
  }

  let interpretation: SearchInterpretation;
  try {
    const vocabulary = await loadSearchVocabulary(database, now);
    interpretation = await interpretSearchQuery({ query, vocabulary, now });
  } catch (error) {
    // Never surface an error status: the client would treat it as a broken
    // search rather than as "no interpretation available".
    log.warn({ err: error, query }, "interpretation failed");
    writeJson(res, 200, { interpreted: false, reason: "error" });
    return;
  }

  cache.set(key, { value: interpretation, at: now });
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }

  writeJson(res, 200, interpretation);
};

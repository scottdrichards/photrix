import { getLogger } from "../observability/logger.ts";

const log = getLogger("ollamaGenerate");

/**
 * Base URL of a locally hosted Ollama instance (e.g. `http://192.168.1.160:11434`).
 * Unset means "no local model available" — callers fall back to their own
 * deterministic text rather than failing the request.
 */
export const ollamaUrl = process.env.PHOTRIX_OLLAMA_URL?.replace(/\/$/, "");

// Small instruct model: a share title is a one-line generation, so the 3B model
// answers in well under a second on the shared GPU and leaves VRAM for Frigate.
const model = process.env.PHOTRIX_OLLAMA_MODEL ?? "llama3.2:3b";
// Generous enough to absorb a cold model load (~7s when Ollama has unloaded
// the model after idling), while a genuinely down GPU box still fails fast.
const timeoutMs = Number(process.env.PHOTRIX_OLLAMA_TIMEOUT_MS) || 15_000;

/**
 * How long Ollama should hold the model in memory after a call.
 *
 * Measured on this deployment: a cold call costs ~14.4s, of which 11.9s is
 * loading the model — actual inference is ~2.5s. Ollama's default keep-alive
 * (5 min) expires between searches, so nearly every interpretation paid the
 * load again. Holding the model resident turns a ~14s answer into ~3s.
 *
 * Set `PHOTRIX_OLLAMA_KEEP_ALIVE=0` to release the memory immediately if the
 * Ollama host needs it for something else.
 */
const keepAlive = process.env.PHOTRIX_OLLAMA_KEEP_ALIVE ?? "30m";

/**
 * Per-call overrides. Defaults reproduce the share-title behaviour exactly, so
 * existing callers are unaffected; longer structured answers (search-query
 * interpretation) need more tokens, a tighter deadline, and JSON-constrained
 * decoding.
 */
export type OllamaGenerateOptions = {
  /** Token budget for the answer. Default 40 (a share title). */
  numPredict?: number;
  /** Request deadline. Defaults to PHOTRIX_OLLAMA_TIMEOUT_MS (15s). */
  timeoutMs?: number;
  /** Constrain decoding to syntactically valid JSON (Ollama `format: "json"`). */
  json?: boolean;
};

/**
 * One-shot completion against the local Ollama server.
 *
 * Returns `null` when Ollama is unconfigured, unreachable, or slow. This is a
 * deliberate best-effort path: every caller has a usable non-LLM fallback, and
 * neither minting a share link nor running a search may fail because the box
 * hosting Ollama is down.
 */
export const ollamaGenerate = async (
  system: string,
  prompt: string,
  options: OllamaGenerateOptions = {},
): Promise<string | null> => {
  if (!ollamaUrl) return null;

  try {
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        system,
        prompt,
        stream: false,
        think: false,
        keep_alive: keepAlive,
        ...(options.json ? { format: "json" } : {}),
        options: { temperature: 0.2, num_predict: options.numPredict ?? 40 },
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? timeoutMs),
    });
    if (!res.ok) {
      log.warn({ status: res.status, model }, "Ollama request failed");
      return null;
    }
    const { response } = (await res.json()) as { response?: string };
    // Reasoning models emit a <think> block ahead of the answer even with
    // `think: false` on older Ollama builds; drop it before using the text.
    const text = response?.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    return text || null;
  } catch (error) {
    log.warn({ err: error, model }, "Ollama unreachable");
    return null;
  }
};

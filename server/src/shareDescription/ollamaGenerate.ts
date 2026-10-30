import { getLogger } from "../observability/logger.ts";

const log = getLogger("ollamaGenerate");

/**
 * Base URL of a locally hosted Ollama instance (e.g. `http://localhost:11434`).
 * Unset means "no local model available" — callers fall back to their own
 * deterministic text rather than failing the request.
 */
export const getOllamaUrl = (): string | undefined =>
  process.env.PHOTRIX_OLLAMA_URL?.replace(/\/$/, "");

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
type OllamaGenerateOptions = {
  /** Token budget for the answer. Default 40 (a share title). */
  numPredict?: number;
  /** Request deadline. Defaults to PHOTRIX_OLLAMA_TIMEOUT_MS (15s). */
  timeoutMs?: number;
  /** Constrain decoding to syntactically valid JSON (Ollama `format: "json"`). */
  json?: boolean;
  /**
   * Base64-encoded image bytes (no `data:` prefix) to attach to the prompt.
   * Requires a vision-capable model — see `model` below.
   */
  images?: string[];
  /** Overrides the module-default PHOTRIX_OLLAMA_MODEL for this call, e.g. a
   * vision model for image-conditioned generations. */
  model?: string;
  /**
   * Overrides the model's default context window (Ollama `options.num_ctx`).
   * An attached image alone can cost ~1000+ tokens once tokenized, so a
   * vision call with a real system prompt easily exceeds the default 4096
   * and gets rejected with `exceed_context_size_error` — bump this for any
   * `images` call rather than relying on the model default.
   */
  numCtx?: number;
  /** Sampling temperature. Default 0.2 (share-title behaviour: terse,
   * low-variance). Some models (e.g. moondream) produce empty/gibberish
   * output at very low temperature when given a tight instruction-style
   * prompt — bump this per-call rather than changing the module default. */
  temperature?: number;
  /** Aborts the call early (e.g. the triggering HTTP request disconnected).
   * Combined with the timeout, not a replacement for it. */
  signal?: AbortSignal;
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
  const ollamaUrl = getOllamaUrl();
  if (!ollamaUrl) return null;

  const effectiveModel = options.model ?? model;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;

  try {
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: effectiveModel,
        system,
        prompt,
        stream: false,
        think: false,
        keep_alive: keepAlive,
        ...(options.json ? { format: "json" } : {}),
        ...(options.images ? { images: options.images } : {}),
        options: {
          temperature: options.temperature ?? 0.2,
          num_predict: options.numPredict ?? 40,
          ...(options.numCtx ? { num_ctx: options.numCtx } : {}),
        },
      }),
      signal,
    });
    if (!res.ok) {
      log.warn({ status: res.status, model: effectiveModel }, "Ollama request failed");
      return null;
    }
    const { response } = (await res.json()) as { response?: string };
    // Reasoning models emit a <think> block ahead of the answer even with
    // `think: false` on older Ollama builds; drop it before using the text.
    const text = response?.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    return text || null;
  } catch (error) {
    log.warn({ err: error, model: effectiveModel }, "Ollama unreachable");
    return null;
  }
};

/**
 * Streaming form of `ollamaGenerate`: calls `onDelta` with each fragment as the
 * model produces it, and resolves with the whole answer (or `null`, on the
 * same best-effort terms).
 *
 * A long vision answer can take minutes when the GPU is contended, so the
 * deadline is an *idle* timeout — how long the model may go silent once it
 * has started — rather than a cap on the whole generation. Before the first
 * token the wait is `firstTokenTimeoutMs` instead: on CPU, behind a queue,
 * the image prompt alone has taken over 90 s. `timeoutMs` bounds the total.
 */
export const ollamaGenerateStream = async (
  system: string,
  prompt: string,
  onDelta: (text: string) => void,
  options: OllamaGenerateOptions & { idleTimeoutMs?: number; firstTokenTimeoutMs?: number } = {},
): Promise<string | null> => {
  const ollamaUrl = getOllamaUrl();
  if (!ollamaUrl) return null;

  const effectiveModel = options.model ?? model;
  const idle = new AbortController();
  const idleTimeoutMs = options.idleTimeoutMs ?? 90_000;
  let idleTimer = setTimeout(() => idle.abort(), options.firstTokenTimeoutMs ?? 300_000);
  const bumpIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(), idleTimeoutMs);
  };
  const signals = [idle.signal, AbortSignal.timeout(options.timeoutMs ?? 600_000)];
  if (options.signal) signals.push(options.signal);
  const signal = AbortSignal.any(signals);

  try {
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: effectiveModel,
        system,
        prompt,
        stream: true,
        think: false,
        keep_alive: keepAlive,
        ...(options.images ? { images: options.images } : {}),
        options: {
          temperature: options.temperature ?? 0.2,
          num_predict: options.numPredict ?? 40,
          ...(options.numCtx ? { num_ctx: options.numCtx } : {}),
        },
      }),
      signal,
    });
    if (!res.ok || !res.body) {
      log.warn({ status: res.status, model: effectiveModel }, "Ollama stream request failed");
      return null;
    }

    // Ollama streams NDJSON: one {"response": "...", "done": bool} per line.
    const decoder = new TextDecoder();
    let buffered = "";
    let text = "";
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      const chunk = JSON.parse(line) as { response?: string };
      if (chunk.response) {
        text += chunk.response;
        onDelta(chunk.response);
      }
    };
    for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(bytes, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      lines.forEach(handleLine);
      if (text) bumpIdle();
    }
    handleLine(buffered);
    return text.trim() || null;
  } catch (error) {
    log.warn({ err: error, model: effectiveModel }, "Ollama stream failed");
    return null;
  } finally {
    clearTimeout(idleTimer);
  }
};

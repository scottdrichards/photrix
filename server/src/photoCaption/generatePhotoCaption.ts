import { getLogger } from "../observability/logger.ts";
import { ollamaGenerate } from "../shareDescription/ollamaGenerate.ts";

const log = getLogger("generatePhotoCaption");

// Vision-capable model. Deliberately separate from the text-only
// PHOTRIX_OLLAMA_MODEL (llama3.2:3b) used for share titles/search
// interpretation — captioning needs to actually look at pixels.
//
// 2026-08-12: switched from qwen2.5vl:3b to moondream:latest after the
// Ollama host (192.168.1.160) was fixed — moondream is ~4-5s warm / ~16s
// cold there, vs. qwen2.5vl's ~170-240s (this deployment had been
// CPU-bound; whatever the ai-lxc side fix was, it changed the economics
// enough that a much shorter timeout below is now safe). Do NOT set
// `num_gpu` on calls to this model — forcing it caused CUDA OOM crashes on
// this box when VRAM is tight (Frigate and other GPU consumers can leave as
// little as 1-2GB free).
const visionModel = process.env.PHOTRIX_OLLAMA_VISION_MODEL ?? "moondream:latest";

// moondream is fast enough now that this only needs to absorb a cold
// keep_alive load (~16s measured) plus box contention, not multi-minute
// generation — see the multi-minute comment history in git blame if
// qwen2.5vl (or an equally slow model) ever comes back into rotation here.
const timeoutMs = Number(process.env.PHOTRIX_OLLAMA_CAPTION_TIMEOUT_MS) || 40_000;

const MAX_WORDS = 6;
const MAX_LENGTH = 60;

// moondream does NOT reliably follow "give me a N-word title"-style
// instructions — at low temperature it produces empty or gibberish output
// when asked that way. Ask for a plain description instead and let
// cleanCaption() below do the truncation to a short toast/title. Facts are
// still prepended as context (helps disambiguate who/when without the model
// inventing details) but the instruction itself stays a plain "describe
// this image", not a format constraint.
const SYSTEM_PROMPT = `You describe photos plainly and factually, in one short sentence. Use any given metadata only to disambiguate who's in the photo or roughly when/where it was taken — never invent details the image itself doesn't show.`;

export type PhotoCaptionFacts = {
  peopleNames: string[];
  dateTaken?: Date | null;
  folder: string;
};

const buildPrompt = ({ peopleNames, dateTaken, folder }: PhotoCaptionFacts): string => {
  const parts: string[] = [];
  if (peopleNames.length > 0) parts.push(`people=[${peopleNames.join(", ")}]`);
  if (dateTaken) parts.push(`date=${dateTaken.toISOString().slice(0, 10)}`);
  const folderLabel = folder.replace(/^\/+|\/+$/g, "");
  if (folderLabel) parts.push(`folder=${folderLabel}`);
  const metadataLine = parts.length > 0 ? `Photo metadata: ${parts.join("; ")}. ` : "";
  return `${metadataLine}Describe this image.`;
};

/**
 * Cleans a raw model reply into a usable short caption. Unlike the old
 * qwen2.5vl prompt (which asked for a tight title directly), moondream
 * reliably returns a fuller sentence/paragraph — so this always truncates
 * down to MAX_WORDS rather than rejecting anything over a small overshoot;
 * only genuinely empty/unusable output returns null.
 *
 * Deliberately does NOT take just `raw.split("\n")[0]` — moondream commonly
 * prefixes its real answer with a leading blank line (confirmed via direct
 * testing: `"\nThe image shows a person's foot..."`), so a first-line-only
 * approach silently threw away every usable reply that happened to start
 * that way, indistinguishable from a genuine empty/failed generation.
 * Collapsing all whitespace/newlines first avoids that trap.
 */
export const cleanCaption = (raw: string): string | null => {
  const cleaned = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”]+|["'”.]+$/g, "")
    .trim();
  if (!cleaned) return null;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const truncated = words.length > MAX_WORDS ? words.slice(0, MAX_WORDS).join(" ") : cleaned;
  return truncated.length > MAX_LENGTH ? truncated.slice(0, MAX_LENGTH).trim() : truncated;
};

/**
 * Generates a <=6-word AI caption for a photo from its pixels + metadata via
 * the vision model on Ollama. Best-effort: returns null on any failure
 * (unconfigured, unreachable, timeout, or an unusable reply) — captions are a
 * non-essential UI enhancement and must never fail photo viewing.
 */
export const generatePhotoCaption = async (
  imageBase64: string,
  facts: PhotoCaptionFacts,
  options: { signal?: AbortSignal } = {},
): Promise<string | null> => {
  const prompt = buildPrompt(facts);
  const raw = await ollamaGenerate(SYSTEM_PROMPT, prompt, {
    images: [imageBase64],
    model: visionModel,
    numPredict: 25,
    temperature: 0.3,
    timeoutMs,
    signal: options.signal,
    // Deliberately no numCtx override here: moondream + the short plain
    // prompt above stays well within the default context, and (per ai-lxc
    // guidance) touching generation options beyond the ones actually needed
    // risks destabilizing the box — num_gpu forced OOM-crashed it, so this
    // stays conservative.
  });
  if (!raw) return null;
  const cleaned = cleanCaption(raw);
  if (!cleaned) {
    log.warn({ raw, model: visionModel }, "Unusable photo caption from Ollama");
    return null;
  }
  return cleaned;
};

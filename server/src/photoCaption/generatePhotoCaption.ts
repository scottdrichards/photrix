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

const MAX_WORDS = 18;
const MAX_LENGTH = 130;

// moondream does NOT reliably follow "give me a N-word title"-style
// instructions — at low temperature it produces empty or gibberish output
// when asked that way. Ask for a plain description instead and let
// cleanCaption() below do the truncation to a short toast/title. Facts are
// still prepended as context (helps disambiguate who/when without the model
// inventing details) but the instruction itself stays a plain "describe
// this image", not a format constraint.
//
// Told explicitly to skip the "This image/photo is/shows..." preamble and to
// lead with the subject — moondream defaults to that preamble otherwise,
// which eats into the MAX_WORDS budget for no informational value. Also
// asked to use given first names and to name the action/setting (e.g. "Alice
// and Amelia running in a field") rather than a bare subject list, since a
// verb + place reads as an actual caption instead of a tag.
const SYSTEM_PROMPT = `Write a warm, casual family-photo caption in one short sentence. Start directly with the subject — never with phrases like "This image is of", "This photo shows", or "A picture of". If people are named in the metadata, use only those first names; never guess or invent a name. Include what they are doing and the setting when visible, using natural album language such as "Alice on a family hike", never clinical or scientific language. Use metadata only to identify people or roughly when/where the photo was taken — never invent details the image does not show.`;
const RETRY_SYSTEM_PROMPT =
  "Describe the photo accurately in plain, everyday English. Do not read filenames, dates, or numbers from the image.";
const RETRY_PROMPT = "What is happening in this image?";

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
  return `${metadataLine}Write a warm, everyday photo-album caption. Use only metadata first names; never guess a name.`;
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
 *
 * Also strips a leading "This image/photo/picture is/shows/depicts (of) "
 * preamble even though the system prompt now asks moondream not to produce
 * one — it doesn't reliably follow that instruction, and the preamble would
 * otherwise burn several words of the MAX_WORDS budget before truncation.
 */
const INTRO_PHRASE =
  /^(?:(?:this|the)?\s*(?:image|photo|picture)\s*(?:is\s+(?:of|showing)|shows|depicts|of)|in\s+(?:this|the)\s+(?:image|photo|picture)[,:]?)\s*/i;

const LEADING_SUBJECT =
  /^(?:(?:a|an|the)\s+)?(?:person|man|woman|boy|girl|child|baby|kid|adult|[a-z][a-z'-]*)\s+(?=(?:is|are|was|were|poses?|stands?|sits?|smiles?|plays?|runs?|walks?|holds?|looks?|wears?|has|with)\b)/i;

const COORDINATE_REPLY = /(?:^|\s)\[?\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\]?(?:\s|$)/;
const HUMAN_ACTION =
  /\b(?:is|are|was|were|posing|standing|sitting|smiling|playing|running|walking|holding|looking|wearing)\b/i;
const GENERIC_NAMED_SUBJECT =
  /^(?:[a-z][a-z'-]*\s+)?(?:image|photo|picture)\s+(?:features|shows|depicts)\s+(?:(?:a|an|the)\s+)?(?:young\s+)?(?:person|man|woman|boy|girl|child|baby|kid|adult)\s+/i;

export const cleanCaption = (raw: string): string | null => {
  const cleaned = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”]+|["'”.]+$/g, "")
    .trim()
    .replace(INTRO_PHRASE, "")
    .trim();
  if (!cleaned) return null;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  if (!words.some((word) => /[a-z]{2,}/i.test(word))) return null;
  const truncated = words.length > MAX_WORDS ? words.slice(0, MAX_WORDS).join(" ") : cleaned;
  return truncated.length > MAX_LENGTH ? truncated.slice(0, MAX_LENGTH).trim() : truncated;
};

/**
 * Face-cluster names are authoritative. Vision models are good at describing
 * an action, but not at recognizing a specific person, so replace their
 * leading subject only when it is a person-like phrase followed by a verb.
 */
export const applyNamedPeople = (caption: string, peopleNames: string[]): string => {
  const firstNames = [
    ...new Set(
      peopleNames
        .map((name) => name.trim().split(/\s+/, 1)[0])
        .filter(Boolean),
    ),
  ];
  if (firstNames.length === 0) return caption;

  const subject = firstNames.join(" and ");
  if (COORDINATE_REPLY.test(caption)) {
    return `${subject} in a family photo`;
  }
  if (GENERIC_NAMED_SUBJECT.test(caption)) {
    const namedCaption = caption.replace(GENERIC_NAMED_SUBJECT, `${subject} `);
    return HUMAN_ACTION.test(namedCaption) ? namedCaption : `${subject} in a family photo`;
  }
  if (LEADING_SUBJECT.test(caption)) {
    const namedCaption = caption.replace(LEADING_SUBJECT, `${subject} `);
    return HUMAN_ACTION.test(namedCaption) ? namedCaption : `${subject} in a family photo`;
  }
  if (firstNames.some((name) => new RegExp(`\\b${name}\\b`, "i").test(caption))) {
    return HUMAN_ACTION.test(caption) ? caption : `${subject} in a family photo`;
  }

  // Title-style replies such as "Ursa Richards family hike" do not contain a
  // verb, so the subject matcher above cannot recognize them. Replace the
  // guessed leading name (and a known surname if present) with the cluster's
  // friendly first name rather than displaying a hallucinated identity.
  const surnames = peopleNames
    .map((name) => name.trim().split(/\s+/).at(-1))
    .filter((name): name is string => !!name)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const guessedSubject = new RegExp(
    `^[a-z][a-z'-]*(?:\\s+(?:${surnames.join("|")}))?\\s*`,
    "i",
  );
  const namedCaption = caption.replace(guessedSubject, `${subject} `);
  return HUMAN_ACTION.test(namedCaption) ? namedCaption : `${subject} in a family photo`;
};

const friendlyFaceCaption = (peopleNames: string[]): string | null => {
  const firstNames = [
    ...new Set(
      peopleNames
        .map((name) => name.trim().split(/\s+/, 1)[0])
        .filter(Boolean),
    ),
  ];
  return firstNames.length > 0 ? `${firstNames.join(" and ")} in a family photo` : null;
};

/**
 * Generates a short (<=18-word) AI caption for a photo from its pixels + metadata via
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
  const generate = (system: string, request: string, temperature: number) =>
    ollamaGenerate(system, request, {
      images: [imageBase64],
      model: visionModel,
      numPredict: 50,
      temperature,
      timeoutMs,
      signal: options.signal,
    });

  let raw = await generate(SYSTEM_PROMPT, prompt, 0.3);
  let cleaned = raw ? cleanCaption(raw) : null;
  if (!cleaned) {
    log.warn({ raw, model: visionModel }, "Retrying unusable photo caption from Ollama");
    raw = await generate(RETRY_SYSTEM_PROMPT, RETRY_PROMPT, 0.5);
    cleaned = raw ? cleanCaption(raw) : null;
  }
  if (!cleaned) {
    const fallback = friendlyFaceCaption(facts.peopleNames);
    if (fallback) return fallback;
    throw new Error("Caption model returned no usable description after retry");
  }
  return applyNamedPeople(cleaned, facts.peopleNames);
};

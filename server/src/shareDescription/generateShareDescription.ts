import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { FilterElement } from "../indexDatabase/indexDatabase.type.ts";
import { ollamaGenerate } from "./ollamaGenerate.ts";
import { summarizeShareFilter } from "./summarizeShareFilter.ts";

const SYSTEM_PROMPT = `You name shared photo albums. Given the facts describing which photos a share link contains, reply with a single short title for that collection.

Rules:
- 2 to 4 words. Title Case. No trailing period.
- Use only the supplied facts. Never invent people, places, events, or dates.
- Do not add themes, moods, or adjectives that the facts do not state. "Shot on a Canon EOS R6" is a camera, not a holiday.
- Facts you cannot phrase naturally should be dropped, not embellished.
- Reply with the title only — no quotes, no explanation, no preamble.`;

const MAX_LENGTH = 30;

/**
 * Short human title for a share link, used as the link-preview headline.
 *
 * The deterministic facet summary is the description whenever the local model
 * is unconfigured, unreachable, or answers with something unusable — a share
 * link must always mint, and that summary is genuinely readable on its own.
 */
export const generateShareDescription = async ({
  filter,
  semanticQuery,
  database,
}: {
  filter: FilterElement;
  semanticQuery?: string;
  database: IndexDatabase;
}): Promise<string> => {
  const facts = await summarizeShareFilter(filter, database);
  if (semanticQuery) {
    facts.unshift({
      text: `Photos matching the search "${semanticQuery}"`,
      nameable: true,
    });
  }
  if (facts.length === 0) return "Shared photos";

  // Feedback #108/#109: a `leadIn` fact (near-city, coarse date — see
  // summarizeShareFilter) glues onto the previous fact with a bare space
  // instead of the usual " · " separator, so it reads as a modifier on it
  // ("Sarah, Scott, Alice, and Amelia near Salt Lake City, UT") rather than
  // an unrelated second sentence.
  const summary = facts.reduce(
    (acc, fact, i) =>
      i === 0 ? fact.text : `${acc}${fact.leadIn ? " " : " · "}${fact.text}`,
    "",
  );
  const nameable = facts.filter(({ nameable }) => nameable);
  if (nameable.length === 0) return summary;

  const title = await ollamaGenerate(
    SYSTEM_PROMPT,
    `Facts about this shared photo collection:\n${nameable.map(({ text }) => `- ${text}`).join("\n")}\n\nTitle:`,
  );
  if (!title) return summary;

  // Models occasionally ignore the format rules; take the first line, strip
  // wrapping quotes, and reject anything too long to be a headline.
  const cleaned = title
    .split("\n")[0]
    .trim()
    .replace(/^["'“”]|["'“”.]$/g, "")
    .trim();
  return cleaned && cleaned.length <= MAX_LENGTH ? cleaned : summary;
};

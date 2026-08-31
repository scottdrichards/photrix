import { getAuthHeaders } from "../auth";
import type { ShareScope } from "../../../shared/filter-contract/src/index";

/**
 * A share above this many items is treated as "large" and asks for explicit
 * confirmation first. Sharing a whole library by accident is the failure this
 * guards: the Share button captures the *current view*, and an unfiltered view
 * is a valid — but rarely intended — share of everything.
 */
export const LARGE_SHARE_THRESHOLD = 1000;

/**
 * How many items a share scope would actually grant, without minting a token.
 *
 * The server counts this through the same filter resolution the enforcement
 * path uses, so a semantic share reports what it really matches rather than its
 * unresolved base filter.
 */
export const fetchShareScopeCount = async (
  shareScope: unknown,
  signal?: AbortSignal,
): Promise<number> => {
  const res = await fetch("/api/auth/share-token?dryRun=1", {
    method: "POST",
    headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(shareScope),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error("Failed to size share");
  const { count } = (await res.json()) as { count: number };
  return count;
};

export type { ShareScope };

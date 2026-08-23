import { fetchWithDiagnostics } from "./http";

/**
 * The standing "hide these by default" filter (feedback #95). Currently the
 * UI only ever writes `{ faceCluster: <numeric id> }` (see PeopleView's
 * "Hide by default" toggle) or `null`, but the server stores/applies any
 * FilterElement, so this stays loosely typed rather than assuming shape.
 */
export type DefaultExclusionFilter = Record<string, unknown> | null;

export const fetchDefaultExclusionFilter = async (): Promise<DefaultExclusionFilter> => {
  const response = await fetchWithDiagnostics(
    "/api/settings/default-exclusion",
    "get default exclusion filter",
    { method: "GET" },
  );
  if (!response.ok) return null;
  const data = (await response.json()) as { filter?: DefaultExclusionFilter };
  return data.filter ?? null;
};

export const setDefaultExclusionFilter = async (
  filter: DefaultExclusionFilter,
): Promise<void> => {
  const response = await fetchWithDiagnostics(
    "/api/settings/default-exclusion",
    "set default exclusion filter",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filter }),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to set default exclusion filter (status ${response.status})`);
  }
};

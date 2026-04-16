import type * as http from "http";
import { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { FilterElement } from "../indexDatabase/indexDatabase.type.ts";
import { measureOperation } from "../observability/requestTrace.ts";
import { writeJson } from "../utils.ts";

type SuggestionsField =
  | "personInImage"
  | "tags"
  | "aiTags"
  | "cameraMake"
  | "cameraModel"
  | "lens"
  | "rating";

type Options = {
  database: IndexDatabase;
};

const suggestionFields: SuggestionsField[] = [
  "personInImage",
  "tags",
  "aiTags",
  "cameraMake",
  "cameraModel",
  "lens",
  "rating",
];

const isSuggestionsField = (value: string): value is SuggestionsField => {
  return suggestionFields.includes(value as SuggestionsField);
};

export const suggestionsRequestHandler = async (
  req: http.IncomingMessage & Required<Pick<http.IncomingMessage, "url">>,
  res: http.ServerResponse,
  { database }: Options,
) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const fieldParam = url.searchParams.get("field") ?? "";
    const query = (url.searchParams.get("q") ?? "").trim();
    const path = (url.searchParams.get("path") ?? "").trim();
    const includeSubfolders = url.searchParams.get("includeSubfolders") === "true";
    const includeCounts = url.searchParams.get("includeCounts") === "true";
    const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    const filterParam = url.searchParams.get("filter");

    if (!isSuggestionsField(fieldParam)) {
      writeJson(res, 400, { error: "Invalid field" });
      return;
    }

    const pathFilter: FilterElement = path
      ? {
          folder: {
            folder: path,
            recursive: includeSubfolders,
          },
        }
      : {};

    const extraFilter: FilterElement | null = filterParam
      ? (JSON.parse(filterParam) as FilterElement)
      : null;

    const filter: FilterElement = extraFilter
      ? {
          operation: "and",
          conditions: [pathFilter, extraFilter],
        }
      : pathFilter;

    const limit = Number.isFinite(limitParam) ? limitParam : 8;

    if (includeCounts) {
      const suggestions = await measureOperation(
        "queryFieldSuggestionsWithCounts",
        () =>
          database.queryFieldSuggestionsWithCounts({
            field: fieldParam,
            search: query,
            filter,
            limit,
          }),
        { category: "db", detail: `field=${fieldParam}` },
      );

      writeJson(res, 200, { suggestions });
      return;
    }

    const suggestions = await measureOperation(
      "queryFieldSuggestions",
      () =>
        database.queryFieldSuggestions({
          field: fieldParam,
          search: query,
          filter,
          limit,
        }),
      { category: "db", detail: `field=${fieldParam}` },
    );

    writeJson(res, 200, { suggestions });
  } catch (error) {
    writeJson(res, 400, {
      error: "Invalid suggestions query",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

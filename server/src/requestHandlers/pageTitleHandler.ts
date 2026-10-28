import type http from "node:http";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { FilterElement } from "../indexDatabase/indexDatabase.type.ts";
import { combineFilters } from "../auth/shareScope.ts";
import { generateShareDescription } from "../shareDescription/generateShareDescription.ts";
import { writeJson } from "../utils.ts";
import { readJsonRequest } from "../common/readBody.ts";

export const pageTitleHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  database: IndexDatabase,
  shareFilter: unknown = null,
): Promise<void> => {
  const body = await readJsonRequest<{ filter?: FilterElement; semanticQuery?: string }>(req, res);
  if (!body) return;

  const callerFilter: FilterElement = body.filter ?? {};
  const title = await generateShareDescription({
    filter: shareFilter
      ? combineFilters([shareFilter, callerFilter])
      : callerFilter,
    semanticQuery: typeof body.semanticQuery === "string" ? body.semanticQuery : undefined,
    database,
  });

  writeJson(res, 200, { title });
};

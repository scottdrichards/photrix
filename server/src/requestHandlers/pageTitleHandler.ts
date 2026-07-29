import type http from "node:http";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import type { FilterElement } from "../indexDatabase/indexDatabase.type.ts";
import { generateShareDescription } from "../shareDescription/generateShareDescription.ts";
import { writeJson } from "../utils.ts";

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });

export const pageTitleHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  database: IndexDatabase,
): Promise<void> => {
  let body: { filter?: FilterElement; semanticQuery?: string };
  try {
    body = JSON.parse(await readBody(req)) as typeof body;
  } catch {
    writeJson(res, 400, { error: "Bad request" });
    return;
  }

  const title = await generateShareDescription({
    filter: (body.filter ?? {}) as FilterElement,
    semanticQuery: typeof body.semanticQuery === "string" ? body.semanticQuery : undefined,
    database,
  });

  writeJson(res, 200, { title });
};

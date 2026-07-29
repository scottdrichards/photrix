import type http from "node:http";
import type { IndexDatabase } from "../indexDatabase/indexDatabase.ts";
import { writeJson } from "../utils.ts";

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });

export const feedbackHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  database: IndexDatabase,
): Promise<void> => {
  let body: { text?: unknown };
  try {
    body = JSON.parse(await readBody(req)) as { text?: unknown };
  } catch {
    writeJson(res, 400, { error: "Invalid JSON" });
    return;
  }

  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    writeJson(res, 400, { error: "text is required" });
    return;
  }

  const text = body.text.trim().slice(0, 2000);
  await database.asyncSqlite.run(
    "INSERT INTO feedback (text, createdAt) VALUES (?, ?)",
    [text, Date.now()],
  );

  writeJson(res, 200, { ok: true });
};

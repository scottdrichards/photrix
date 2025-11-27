import * as http from "http";

export const healthRequestHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", message: "Server is running" }));
};

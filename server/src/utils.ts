import type * as http from "http";

export type AssertNever<T extends never> = T;

export type UnionXOR<A, B> = Exclude<A, B> | Exclude<B, A>;
export const writeJson = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

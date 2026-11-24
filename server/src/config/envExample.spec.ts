import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import { renderEnvExample } from "./envExample.ts";

describe("server/.env.example", () => {
  it("is up to date with config.ts (regenerate: bun run --filter server env:example)", () => {
    const committed = readFileSync(
      new URL("../../.env.example", import.meta.url),
      "utf8",
    );
    expect(committed).toBe(renderEnvExample());
  });
});

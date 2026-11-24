import { describe, expect, it } from "@jest/globals";
import { parseByteRange } from "./streamFile.ts";

describe("parseByteRange", () => {
  it.each([
    ["bytes=0-99", { start: 0, end: 99 }],
    ["bytes=100-", { start: 100, end: 999 }],
    ["bytes=999-999", { start: 999, end: 999 }],
  ])("reads %s", (header, range) => {
    expect(parseByteRange(header, 1000)).toEqual(range);
  });

  it.each([
    [undefined],
    ["bytes=-100"],
    ["bytes=500-100"],
    ["bytes=0-1000"],
    ["bytes=1000-"],
    ["bytes=0-1,5-9"],
    ["items=0-1"],
  ])("sends the whole body for %s", (header) => {
    expect(parseByteRange(header, 1000)).toBeNull();
  });
});

import { describe, expect, it } from "@jest/globals";
import { resolveDateIntent } from "./resolveDateIntent.ts";

// A fixed "now" so every relative intent has a checkable answer.
const JULY_2026 = Date.UTC(2026, 6, 15, 12, 0, 0);
const FEBRUARY_2026 = Date.UTC(2026, 1, 10, 12, 0, 0);

const iso = (ms: number) => new Date(ms).toISOString();

describe("resolveDateIntent", () => {
  it("resolves an absolute year to its full calendar span", () => {
    const range = resolveDateIntent({ kind: "year", year: 2019 }, JULY_2026);
    expect(range).not.toBeNull();
    expect(iso(range!.start)).toBe("2019-01-01T00:00:00.000Z");
    expect(iso(range!.end)).toBe("2019-12-31T23:59:59.999Z");
    expect(range!.label).toBe("2019");
  });

  it("orders a reversed year range and labels it", () => {
    const range = resolveDateIntent(
      { kind: "yearRange", startYear: 2018, endYear: 2015 },
      JULY_2026,
    );
    expect(iso(range!.start)).toBe("2015-01-01T00:00:00.000Z");
    expect(iso(range!.end)).toBe("2018-12-31T23:59:59.999Z");
    expect(range!.label).toBe("2015–2018");
  });

  it("resolves 'last summer' against the request clock, not a constant", () => {
    const range = resolveDateIntent(
      { kind: "season", season: "summer", yearsAgo: 1 },
      JULY_2026,
    );
    expect(iso(range!.start)).toBe("2025-06-01T00:00:00.000Z");
    expect(iso(range!.end)).toBe("2025-08-31T23:59:59.999Z");
    expect(range!.label).toBe("Summer 2025");
  });

  it("falls back a year when this year's season has not started yet", () => {
    // Asked in February, "this summer" can only mean the one that has happened.
    const range = resolveDateIntent(
      { kind: "season", season: "summer", yearsAgo: 0 },
      FEBRUARY_2026,
    );
    expect(range!.label).toBe("Summer 2025");
  });

  it("spans winter across the year boundary and ends leap-safely", () => {
    const range = resolveDateIntent(
      { kind: "season", season: "winter", yearsAgo: 2 },
      JULY_2026,
    );
    expect(iso(range!.start)).toBe("2023-12-01T00:00:00.000Z");
    expect(iso(range!.end)).toBe("2024-02-29T23:59:59.999Z");
    expect(range!.label).toBe("Winter 2024");
  });

  it("resolves 'two Christmases ago' to a window around December 25", () => {
    const range = resolveDateIntent(
      { kind: "holiday", holiday: "christmas", yearsAgo: 2 },
      JULY_2026,
    );
    expect(iso(range!.start)).toBe("2024-12-20T00:00:00.000Z");
    expect(iso(range!.end)).toBe("2024-12-27T23:59:59.999Z");
    expect(range!.label).toBe("Christmas 2024");
  });

  it("uses the current year's Christmas only once it has arrived", () => {
    // In July, "this Christmas" has not happened; the newest one is last year's.
    expect(
      resolveDateIntent(
        { kind: "holiday", holiday: "christmas", yearsAgo: 0 },
        JULY_2026,
      )!.label,
    ).toBe("Christmas 2025");
    expect(
      resolveDateIntent(
        { kind: "holiday", holiday: "christmas", yearsAgo: 0 },
        Date.UTC(2026, 11, 26),
      )!.label,
    ).toBe("Christmas 2026");
  });

  it("computes Thanksgiving as the fourth Thursday of November", () => {
    // Thanksgiving 2025 is November 27; the window runs Wednesday to Sunday.
    const range = resolveDateIntent(
      { kind: "holiday", holiday: "thanksgiving", yearsAgo: 0 },
      Date.UTC(2025, 11, 1),
    );
    expect(iso(range!.start)).toBe("2025-11-26T00:00:00.000Z");
    expect(iso(range!.end)).toBe("2025-11-30T23:59:59.999Z");
  });

  it("computes Easter with the Gregorian computus", () => {
    // Easter 2024 fell on March 31, so the window crosses into April.
    const range = resolveDateIntent(
      { kind: "holiday", holiday: "easter", yearsAgo: 2 },
      JULY_2026,
    );
    expect(iso(range!.start)).toBe("2024-03-29T00:00:00.000Z");
    expect(iso(range!.end)).toBe("2024-04-01T23:59:59.999Z");
  });

  it("resolves a bare month to its most recent occurrence", () => {
    expect(resolveDateIntent({ kind: "month", month: 12 }, JULY_2026)!.label).toBe(
      "December 2025",
    );
    expect(resolveDateIntent({ kind: "month", month: 3 }, JULY_2026)!.label).toBe(
      "March 2026",
    );
  });

  it("honours an explicit year on a month", () => {
    const range = resolveDateIntent({ kind: "month", month: 2, year: 2024 }, JULY_2026);
    expect(iso(range!.start)).toBe("2024-02-01T00:00:00.000Z");
    expect(iso(range!.end)).toBe("2024-02-29T23:59:59.999Z");
  });

  it("measures a recent window backwards from now", () => {
    const range = resolveDateIntent({ kind: "recent", unit: "day", n: 30 }, JULY_2026);
    expect(range!.end).toBe(JULY_2026);
    expect(range!.start).toBe(JULY_2026 - 30 * 24 * 60 * 60 * 1000);
    expect(range!.label).toBe("Last 30 days");
  });

  it.each([
    ["not an object", "last summer"],
    ["an unknown kind", { kind: "fortnight" }],
    ["a missing kind", { year: 2019 }],
    ["an implausible year", { kind: "year", year: 1200 }],
    ["a future year", { kind: "year", year: 2099 }],
    ["a bad season", { kind: "season", season: "monsoon" }],
    ["a bad month", { kind: "month", month: 13 }],
    ["a fractional month", { kind: "month", month: 6.5 }],
    ["a bad holiday", { kind: "holiday", holiday: "birthday" }],
    ["a negative yearsAgo", { kind: "season", season: "summer", yearsAgo: -1 }],
    ["a bad recent unit", { kind: "recent", unit: "fortnight", n: 2 }],
    ["a zero-length recent window", { kind: "recent", unit: "day", n: 0 }],
    ["null", null],
  ])("rejects %s", (_label, intent) => {
    expect(resolveDateIntent(intent, JULY_2026)).toBeNull();
  });
});

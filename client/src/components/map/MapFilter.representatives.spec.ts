import {
  DEFAULT_MIN_SEPARATION_PX,
  selectRepresentatives,
  type PixelCandidate,
} from "./MapFilter.representatives";

const candidate = (
  key: string,
  x: number,
  y: number,
  weight = 1,
): PixelCandidate => ({ key, x, y, weight });

const viewport = { width: 800, height: 600 };

describe("selectRepresentatives", () => {
  it("never returns more than the cap, however many pins there are", () => {
    // A 7x5 in-bounds grid at 110px spacing: 35 candidates all clearing the
    // separation floor, so the cap is what binds rather than the geometry.
    const grid: PixelCandidate[] = [];
    for (let column = 0; column < 7; column += 1) {
      for (let row = 0; row < 5; row += 1) {
        grid.push(candidate(`k${column}-${row}`, 50 + column * 110, 50 + row * 110));
      }
    }
    expect(grid).toHaveLength(35);
    expect(selectRepresentatives(grid, { ...viewport, cap: 12 })).toHaveLength(12);

    // Piling on hundreds more pins in the same space cannot grow the result.
    const crowded = [
      ...grid,
      ...Array.from({ length: 500 }, (_, index) =>
        candidate(`extra${index}`, 60 + (index % 600), 60 + (index % 480)),
      ),
    ];
    expect(
      selectRepresentatives(crowded, { ...viewport, cap: 12 }).length,
    ).toBeLessThanOrEqual(12);
  });

  it("rejects candidates closer than the separation floor", () => {
    const chosen = selectRepresentatives(
      [candidate("a", 400, 300, 10), candidate("b", 410, 300, 9)],
      viewport,
    );
    expect(chosen.map((item) => item.key)).toEqual(["a"]);
  });

  it("keeps candidates that clear the separation floor", () => {
    const chosen = selectRepresentatives(
      [
        candidate("a", 200, 300, 10),
        candidate("b", 200 + DEFAULT_MIN_SEPARATION_PX + 1, 300, 9),
      ],
      viewport,
    );
    expect(chosen.map((item) => item.key)).toEqual(["a", "b"]);
  });

  it("prefers the busiest pin when two compete for the same area", () => {
    const chosen = selectRepresentatives(
      [candidate("small", 400, 300, 1), candidate("big", 405, 300, 99)],
      viewport,
    );
    expect(chosen.map((item) => item.key)).toEqual(["big"]);
  });

  it("drops pins too close to the edge to render a full bubble", () => {
    const chosen = selectRepresentatives(
      [candidate("corner", 1, 1, 50), candidate("middle", 400, 300, 1)],
      viewport,
    );
    expect(chosen.map((item) => item.key)).toEqual(["middle"]);
  });

  it("ignores non-finite positions", () => {
    const chosen = selectRepresentatives(
      [candidate("nan", Number.NaN, 300), candidate("ok", 400, 300)],
      viewport,
    );
    expect(chosen.map((item) => item.key)).toEqual(["ok"]);
  });

  it("is stable: the same view yields the same picks in the same order", () => {
    const pins = [
      candidate("a", 200, 200, 5),
      candidate("b", 500, 200, 5),
      candidate("c", 200, 500, 5),
    ];
    expect(selectRepresentatives(pins, viewport)).toEqual(
      selectRepresentatives([...pins].reverse(), viewport),
    );
  });

  it("returns nothing for a degenerate viewport", () => {
    expect(
      selectRepresentatives([candidate("a", 10, 10)], { width: 0, height: 0 }),
    ).toEqual([]);
  });
});

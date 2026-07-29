import type { GeoPoint } from "../api";
import {
  AGE_RAMP,
  UNDATED_PIN_COLOR,
  buildAgeLegend,
  buildAgeScale,
  colorForDate,
  formatAgeRangeLabel,
  pointDate,
} from "./MapFilter.age";

const point = (overrides: Partial<GeoPoint> = {}): GeoPoint => ({
  path: "a.jpg",
  name: "a.jpg",
  latitude: 0,
  longitude: 0,
  ...overrides,
});

const JAN_2020 = Date.UTC(2020, 0, 1);
const JAN_2024 = Date.UTC(2024, 0, 1);

describe("pointDate", () => {
  it("uses the midpoint of a bucket's range", () => {
    expect(pointDate(point({ minDate: 0, maxDate: 100 }))).toBe(50);
  });

  it("falls back to whichever edge is present", () => {
    expect(pointDate(point({ minDate: 42 }))).toBe(42);
    expect(pointDate(point({ maxDate: 7 }))).toBe(7);
  });

  it("is undefined when the pin carries no date", () => {
    expect(pointDate(point())).toBeUndefined();
  });
});

describe("buildAgeScale", () => {
  it("spans the oldest and newest dated pins", () => {
    const scale = buildAgeScale([
      point({ minDate: JAN_2020, maxDate: JAN_2020 }),
      point({ minDate: JAN_2024, maxDate: JAN_2024 }),
    ]);
    expect(scale).toEqual({
      minDate: JAN_2020,
      maxDate: JAN_2024,
      stepCount: AGE_RAMP.length,
    });
  });

  it("ignores undated pins entirely", () => {
    const scale = buildAgeScale([point(), point({ minDate: JAN_2020, maxDate: JAN_2020 })]);
    expect(scale?.minDate).toBe(JAN_2020);
  });

  it("is null when nothing is dated", () => {
    expect(buildAgeScale([point(), point()])).toBeNull();
  });

  it("collapses to one step when every pin shares a date", () => {
    const scale = buildAgeScale([point({ minDate: JAN_2020, maxDate: JAN_2020 })]);
    expect(scale?.stepCount).toBe(1);
  });
});

describe("colorForDate", () => {
  const scale = buildAgeScale([
    point({ minDate: JAN_2020, maxDate: JAN_2020 }),
    point({ minDate: JAN_2024, maxDate: JAN_2024 }),
  ]);

  it("puts the oldest at the light end and the newest at the dark end", () => {
    expect(colorForDate(scale, JAN_2020)).toBe(AGE_RAMP[0]);
    expect(colorForDate(scale, JAN_2024)).toBe(AGE_RAMP[AGE_RAMP.length - 1]);
  });

  it("orders monotonically across the range", () => {
    const span = JAN_2024 - JAN_2020;
    const indices = [0, 0.25, 0.5, 0.75, 1].map((ratio) =>
      AGE_RAMP.indexOf(
        colorForDate(scale, JAN_2020 + span * ratio) as (typeof AGE_RAMP)[number],
      ),
    );
    const sorted = [...indices].sort((a, b) => a - b);
    expect(indices).toEqual(sorted);
  });

  it("gives undated pins the neutral middle step", () => {
    expect(colorForDate(scale, undefined)).toBe(UNDATED_PIN_COLOR);
  });

  it("never returns an out-of-range colour for dates outside the scale", () => {
    expect(AGE_RAMP).toContain(colorForDate(scale, JAN_2020 - 1_000_000));
    expect(AGE_RAMP).toContain(colorForDate(scale, JAN_2024 + 1_000_000));
  });
});

describe("buildAgeLegend", () => {
  it("emits one contiguous step per ramp colour", () => {
    const scale = buildAgeScale([
      point({ minDate: JAN_2020, maxDate: JAN_2020 }),
      point({ minDate: JAN_2024, maxDate: JAN_2024 }),
    ]);
    const legend = buildAgeLegend(scale);
    expect(legend).toHaveLength(AGE_RAMP.length);
    expect(legend.map((step) => step.color)).toEqual([...AGE_RAMP]);
    legend.slice(1).forEach((step, index) => {
      expect(step.start).toBeCloseTo(legend[index].end, 5);
    });
  });

  it("is empty without a scale", () => {
    expect(buildAgeLegend(null)).toEqual([]);
  });
});

describe("formatAgeRangeLabel", () => {
  it("collapses to a single edge when the range is one instant", () => {
    const scale = buildAgeScale([point({ minDate: JAN_2020, maxDate: JAN_2020 })]);
    expect(formatAgeRangeLabel(scale)).not.toContain("–");
  });

  it("says so when there is nothing to scale", () => {
    expect(formatAgeRangeLabel(null)).toBe("No dates available");
  });
});

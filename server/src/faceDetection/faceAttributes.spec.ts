import { describe, expect, it } from "@jest/globals";
import {
  FACE_ATTRIBUTE_KEYS,
  faceAttributeConditions,
  isFaceAttributeKey,
  parseFaceAttributes,
} from "./faceAttributes.ts";

describe("faceAttributeConditions", () => {
  it("returns nothing when no attributes are requested", () => {
    expect(faceAttributeConditions([])).toEqual({ conditions: [], params: [] });
  });

  it("treats an unscored face as a match by default", () => {
    const { conditions, params } = faceAttributeConditions(["smiling"]);

    // NULL means "not analysed yet", which is not the same as "not smiling".
    expect(conditions).toEqual(["(faces.smileScore IS NULL OR faces.smileScore >= ?)"]);
    expect(params).toEqual([0.5]);
  });

  it("drops unscored faces only when the caller opts in", () => {
    const { conditions, params } = faceAttributeConditions(["smiling"], {
      includeUnknown: false,
    });

    expect(conditions).toEqual(["faces.smileScore >= ?"]);
    expect(params).toEqual([0.5]);
  });

  it("emits one condition per attribute, in canonical order", () => {
    const requested = ["wellExposed", "smiling", "inFocus", "eyesOpen"] as const;
    const { conditions } = faceAttributeConditions(requested);

    expect(conditions).toHaveLength(4);
    expect(conditions.map((condition) => /faces\.(\w+)/.exec(condition)![1])).toEqual([
      "smileScore",
      "eyesOpenScore",
      "focusScore",
      "exposureScore",
    ]);
  });

  it("keeps conditions and params aligned by placeholder position", () => {
    const { conditions, params } = faceAttributeConditions(["smiling", "inFocus"]);
    const placeholders = conditions.join(" ").split("?").length - 1;

    expect(placeholders).toBe(params.length);
  });

  it("covers every declared attribute key", () => {
    const { conditions } = faceAttributeConditions(FACE_ATTRIBUTE_KEYS);
    expect(conditions).toHaveLength(FACE_ATTRIBUTE_KEYS.length);
  });
});

describe("isFaceAttributeKey", () => {
  it("accepts declared keys and rejects everything else", () => {
    expect(isFaceAttributeKey("smiling")).toBe(true);
    expect(isFaceAttributeKey("wearingAHat")).toBe(false);
    expect(isFaceAttributeKey(3)).toBe(false);
    expect(isFaceAttributeKey(null)).toBe(false);
    expect(isFaceAttributeKey(undefined)).toBe(false);
  });
});

describe("parseFaceAttributes", () => {
  it("keeps the four known scores", () => {
    expect(
      parseFaceAttributes({ smile: 0.9, eyesOpen: 0.1, focus: 0.5, exposure: 0.75 }),
    ).toEqual({ smile: 0.9, eyesOpen: 0.1, focus: 0.5, exposure: 0.75 });
  });

  it("omits attributes the worker could not judge", () => {
    // The worker signals "unknown" by leaving the key out entirely; the parsed
    // result must preserve that rather than substituting a zero.
    expect(parseFaceAttributes({ focus: 0.4 })).toEqual({ focus: 0.4 });
  });

  it("clamps out-of-range scores instead of storing them raw", () => {
    expect(parseFaceAttributes({ smile: 1.4, focus: -0.2 })).toEqual({
      smile: 1,
      focus: 0,
    });
  });

  it("discards non-finite and non-numeric values as unknown", () => {
    expect(
      parseFaceAttributes({
        smile: Number.NaN,
        eyesOpen: Number.POSITIVE_INFINITY,
        focus: "0.8",
        exposure: null,
      }),
    ).toEqual({});
  });

  it("tolerates junk payloads", () => {
    expect(parseFaceAttributes(null)).toEqual({});
    expect(parseFaceAttributes(undefined)).toEqual({});
    expect(parseFaceAttributes("smiling")).toEqual({});
  });

  it("ignores extra keys the worker may add later", () => {
    expect(parseFaceAttributes({ smile: 0.6, wearingAHat: 1 })).toEqual({ smile: 0.6 });
  });
});

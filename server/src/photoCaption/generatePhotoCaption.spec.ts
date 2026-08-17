import { describe, expect, it } from "@jest/globals";
import { applyNamedPeople, cleanCaption } from "./generatePhotoCaption.ts";

describe("applyNamedPeople", () => {
  it("replaces a vision-model's guessed subject with the named face cluster", () => {
    expect(applyNamedPeople("urny is posing for a photo", ["Ryan Simmons Richards"])).toBe(
      "Ryan is posing for a photo",
    );
  });

  it("replaces a guessed name in a title-style caption", () => {
    expect(applyNamedPeople("Ursa Richards family hike", ["Ryan Simmons Richards"])).toBe(
      "Ryan in a family photo",
    );
  });

  it("removes generic image-subject wording for a named face", () => {
    expect(
      applyNamedPeople("Alice image features a young girl standing in front of a door", [
        "Alice Diane Richards",
      ]),
    ).toBe("Alice standing in front of a door");
  });

  it("replaces model coordinates with a friendly face-derived caption", () => {
    expect(applyNamedPeople("Ryan [0.47, 0.38, 0.67, 0.79]", ["Ryan Simmons Richards"])).toBe(
      "Ryan in a family photo",
    );
  });

  it("preserves captions without named face clusters", () => {
    expect(applyNamedPeople("a person is posing for a photo", [])).toBe(
      "a person is posing for a photo",
    );
  });
});

describe("cleanCaption", () => {
  it("removes the vision-model photo preamble", () => {
    expect(cleanCaption("This image shows a person standing outside")).toBe(
      "a person standing outside",
    );
    expect(cleanCaption("In the image, a group of children are boarding a bus")).toBe(
      "a group of children are boarding a bus",
    );
  });

  it("rejects numeric and punctuation-only model output", () => {
    expect(cleanCaption("!!! 202 6 8 3")).toBeNull();
  });
});

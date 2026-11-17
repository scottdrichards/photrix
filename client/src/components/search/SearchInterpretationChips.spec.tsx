import { render, screen, within } from "@testing-library/react";
import type { InterpretedFilterChip } from "../../../../shared/filter-contract/src";
import { SearchInterpretationChips } from "./SearchInterpretationChips";

vi.mock("../../storage", () => ({
  readStorage: () => null,
  writeStorage: () => {},
}));

const renderChips = (chips: InterpretedFilterChip[]) =>
  render(
    <SearchInterpretationChips
      query="whatever was typed"
      chips={chips}
      ignored={[]}
      onRemoveChip={() => {}}
      onUndo={() => {}}
    />,
  );

/** The chip is the element that holds both the label and its remove button. */
const chipFor = (label: string) =>
  screen.getByRole("button", { name: `Remove filter ${label}` })
    .parentElement as HTMLElement;

describe("SearchInterpretationChips", () => {
  it("marks every chip with the kind of filter it set (feedback #188)", () => {
    renderChips([
      { field: "faceClusterFilter", label: "Ana", value: "person-1" },
      { field: "peopleInImageFilter", label: "Bo", value: "Bo" },
      { field: "path", label: "Folder: Trips" },
      { field: "mediaTypeFilter", label: "Videos only" },
      { field: "ratingFilter", label: "4+ stars" },
      { field: "dateRange", label: "2022" },
      { field: "semanticQuery", label: "“at the lake”" },
    ]);

    const kinds: Array<[string, string]> = [
      ["Ana", "Face"],
      ["Bo", "Tagged person"],
      ["Folder: Trips", "Folder"],
      ["Videos only", "Media type"],
      ["4+ stars", "Rating"],
      ["2022", "Date"],
      ["“at the lake”", "Search text"],
    ];
    for (const [label, kind] of kinds) {
      const icon = within(chipFor(label)).getByRole("img", { name: kind });
      expect(icon.querySelector("svg")).not.toBeNull();
    }
  });

  it("tells a photos-only chip from a videos-only one by its icon", () => {
    renderChips([{ field: "mediaTypeFilter", label: "Photos only" }]);
    const photo = within(chipFor("Photos only")).getByRole("img").innerHTML;
    screen.getByRole("button", { name: "Remove filter Photos only" });

    renderChips([{ field: "mediaTypeFilter", label: "Videos only" }]);
    const video = within(chipFor("Videos only")).getByRole("img").innerHTML;
    expect(video).not.toBe(photo);
  });
});

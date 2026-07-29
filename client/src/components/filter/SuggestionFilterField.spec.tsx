import { act, render } from "@testing-library/react";
import { vi } from "vitest";
import { SuggestionFilterField } from "./SuggestionFilterField";

const fetchSuggestionsWithCountsMock = vi.fn();

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    fetchSuggestionsWithCounts: (...args: unknown[]) =>
      fetchSuggestionsWithCountsMock(...args),
  };
});

describe("SuggestionFilterField", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchSuggestionsWithCountsMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not refetch on rerender when optional array filters are omitted", async () => {
    fetchSuggestionsWithCountsMock.mockImplementation(() => new Promise(() => {}));

    render(
      <SuggestionFilterField
        title="People in image"
        placeholder="Search names"
        loadingLabel="Finding people..."
        field="personInImage"
        selectedValues={[]}
        onSelectedValuesChange={() => {}}
        isActive
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(fetchSuggestionsWithCountsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(fetchSuggestionsWithCountsMock).toHaveBeenCalledTimes(1);
  });
});

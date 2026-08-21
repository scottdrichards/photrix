import {
  buildAppUrl,
  navigationKey,
  parseAppUrlState,
  type AppUrlState,
} from "./filterUrlState";

/** Round-trips a state through the URL and back, the way a refresh does. */
const roundTrip = (state: AppUrlState): AppUrlState => {
  const url = buildAppUrl(state);
  const [pathname = "", search = ""] = url.split("?");
  return parseAppUrlState({ pathname, search: search ? `?${search}` : "" });
};

const baseState = (overrides: Partial<AppUrlState> = {}): AppUrlState => ({
  view: "library",
  filter: { includeSubfolders: true, path: "" },
  people: { personId: null, groupId: null },
  ...overrides,
});

describe("app URL state", () => {
  it("keeps a default library view clean", () => {
    expect(buildAppUrl(baseState())).not.toContain("view=");
  });

  it("restores the open person across a refresh", () => {
    const restored = roundTrip(
      baseState({ view: "people", people: { personId: "person-12", groupId: null } }),
    );
    expect(restored.view).toBe("people");
    expect(restored.people).toEqual({ personId: "person-12", groupId: null });
  });

  it("restores a group opened inside a person", () => {
    const restored = roundTrip(
      baseState({
        view: "people",
        people: { personId: "person-12", groupId: "person-98" },
      }),
    );
    expect(restored.people).toEqual({ personId: "person-12", groupId: "person-98" });
  });

  it("carries filters through a refresh", () => {
    const restored = roundTrip(
      baseState({
        filter: {
          includeSubfolders: false,
          path: "trip/2024/",
          mediaTypeFilter: "video",
          faceClusterFilter: ["person-3"],
        },
      }),
    );
    expect(restored.filter.path).toBe("trip/2024/");
    expect(restored.filter.includeSubfolders).toBe(false);
    expect(restored.filter.mediaTypeFilter).toBe("video");
    expect(restored.filter.faceClusterFilter).toEqual(["person-3"]);
  });

  describe("face attributes", () => {
    it("round-trips a selection", () => {
      const restored = roundTrip(
        baseState({
          filter: {
            includeSubfolders: true,
            path: "",
            faceClusterFilter: ["person-3", "person-7"],
            faceClusterMatchMode: "any",
            faceAttributeFilter: { attributes: ["smiling", "eyesOpen"] },
          },
        }),
      );
      expect(restored.filter.faceClusterFilter).toEqual(["person-3", "person-7"]);
      expect(restored.filter.faceClusterMatchMode).toBe("any");
      expect(restored.filter.faceAttributeFilter).toEqual({
        attributes: ["smiling", "eyesOpen"],
      });
    });

    it("round-trips the strict reading of unscored faces", () => {
      const restored = roundTrip(
        baseState({
          filter: {
            includeSubfolders: true,
            path: "",
            faceAttributeFilter: {
              attributes: ["smiling", "inFocus"],
              includeUnknown: false,
            },
          },
        }),
      );
      expect(restored.filter.faceAttributeFilter).toEqual({
        attributes: ["smiling", "inFocus"],
        includeUnknown: false,
      });
    });

    it("omits the param entirely when nothing is selected", () => {
      expect(buildAppUrl(baseState())).not.toContain("attr=");
      expect(buildAppUrl(baseState())).not.toContain("faceMode=");
      expect(
        buildAppUrl(
          baseState({
            filter: {
              includeSubfolders: true,
              path: "",
              faceAttributeFilter: { attributes: [] },
            },
          }),
        ),
      ).not.toContain("attr=");
      expect(
        buildAppUrl(
          baseState({
            filter: {
              includeSubfolders: true,
              path: "",
              faceClusterMatchMode: "any",
            },
          }),
        ),
      ).not.toContain("faceMode=");
    });

    it("drops unknown keys rather than returning an impossible filter", () => {
      // A stale or hand-edited link must degrade to a weaker filter, never to
      // something that silently matches nothing.
      const state = parseAppUrlState({
        pathname: "/",
        search: "?attr=smiling&attr=notARealAttribute",
      });
      expect(state.filter.faceAttributeFilter).toEqual({ attributes: ["smiling"] });
    });
  });

  describe("navigationKey", () => {
    it("changes when the person changes, so back steps through people", () => {
      const a = buildAppUrl(
        baseState({ view: "people", people: { personId: "person-1", groupId: null } }),
      );
      const b = buildAppUrl(
        baseState({ view: "people", people: { personId: "person-2", groupId: null } }),
      );
      expect(navigationKey(a)).not.toBe(navigationKey(b));
    });

    it("is unchanged by a filter tweak, so filters replace instead of stacking", () => {
      const a = buildAppUrl(baseState({ filter: { includeSubfolders: true, path: "" } }));
      const b = buildAppUrl(
        baseState({
          filter: { includeSubfolders: true, path: "", mediaTypeFilter: "photo" },
        }),
      );
      expect(navigationKey(a)).toBe(navigationKey(b));
    });
  });
});

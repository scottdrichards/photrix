import { navReducer } from "./appNavigation";
import { NO_PEOPLE_SELECTION } from "./filterUrlState";
import type { UrlNavState } from "./hooks/useSyncUrlWithFilter";

const people = { personId: "person-1", groupId: null } as UrlNavState["people"];
const base: UrlNavState = { view: "people", people, previewPath: "/a.jpg" };

describe("navReducer", () => {
  it("keeps the People selection when switching to the People tab, and drops the preview", () => {
    expect(navReducer(base, { type: "viewChanged", view: "people" })).toEqual({
      view: "people",
      people,
      previewPath: null,
    });
  });

  it("clears the People selection and the preview when leaving the People tab", () => {
    expect(navReducer(base, { type: "viewChanged", view: "library" })).toEqual({
      view: "library",
      people: NO_PEOPLE_SELECTION,
      previewPath: null,
    });
  });

  it("changes the selection without touching the view or preview, and passes replace through", () => {
    expect(navReducer(base, { type: "peopleNavigated", people: NO_PEOPLE_SELECTION, replace: true })).toEqual({
      view: "people",
      people: NO_PEOPLE_SELECTION,
      previewPath: "/a.jpg",
      replace: true,
    });
  });

  it("returns the same state when the preview did not change", () => {
    expect(navReducer(base, { type: "previewChanged", path: "/a.jpg" })).toBe(base);
    expect(navReducer(base, { type: "previewChanged", path: null }).previewPath).toBeNull();
  });

  it("takes the URL's state as given", () => {
    const next: UrlNavState = { view: "library", people: NO_PEOPLE_SELECTION, previewPath: null };
    expect(navReducer(base, { type: "urlChanged", next })).toBe(next);
  });
});

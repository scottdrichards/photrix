import { applyTheme, MANIFEST_HREFS } from "./theme";

const setHead = () => {
  document.head.innerHTML =
    '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f7f7f7" />' +
    '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#11161d" />' +
    '<link rel="manifest" href="/manifest.webmanifest" />';
};

const themeColors = () =>
  Array.from(document.querySelectorAll('meta[name="theme-color"]')).map((m) => m.getAttribute("content"));

const manifestHref = () => document.querySelector('link[rel="manifest"]')!.getAttribute("href");

describe("applyTheme", () => {
  beforeEach(setHead);

  it("sets every theme-color tag, so an in-app override beats the system variant", () => {
    applyTheme("dark");
    expect(themeColors()).toEqual(["#11161d", "#11161d"]);
    applyTheme("light");
    expect(themeColors()).toEqual(["#f7f7f7", "#f7f7f7"]);
  });

  it("points the manifest link at the manifest for the theme being shown", () => {
    applyTheme("dark");
    expect(manifestHref()).toBe(MANIFEST_HREFS.dark);
    applyTheme("light");
    expect(manifestHref()).toBe(MANIFEST_HREFS.light);
  });
});

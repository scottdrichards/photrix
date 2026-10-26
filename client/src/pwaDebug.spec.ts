import { applyTheme } from "./theme";
import { getPwaDebugVariant, initPwaDebug, manifestHrefFor, resetPwaDebugForTests } from "./pwaDebug";

const setUrl = (search: string) => window.history.replaceState(null, "", `/${search}`);

const setHead = () => {
  document.head.innerHTML =
    '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f7f7f7" />' +
    '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#11161d" />' +
    '<link rel="manifest" href="/manifest.webmanifest" />';
  document.body.innerHTML = "";
};

const themeColors = () =>
  Array.from(document.querySelectorAll('meta[name="theme-color"]')).map((m) => m.getAttribute("content"));

const click = (label: string) =>
  Array.from(document.querySelectorAll("button"))
    .find((b) => b.textContent === label)!
    .click();

describe("theme-color", () => {
  beforeEach(setHead);

  it("applyTheme sets every theme-color tag, so an app override beats the system variant", () => {
    applyTheme("dark");
    expect(themeColors()).toEqual(["#11161d", "#11161d"]);
    applyTheme("light");
    expect(themeColors()).toEqual(["#f7f7f7", "#f7f7f7"]);
  });
});

describe("pwa debug mode", () => {
  beforeEach(() => {
    setHead();
    resetPwaDebugForTests();
    setUrl("");
  });

  it("is off without the query parameter", () => {
    expect(initPwaDebug()).toBe(false);
    expect(document.querySelector('[data-testid="pwa-debug-panel"]')).toBeNull();
    expect(document.querySelector('link[rel="manifest"]')!.getAttribute("href")).toBe("/manifest.webmanifest");
  });

  it("ignores an unknown variant", () => {
    setUrl("?pwa-debug=z");
    expect(getPwaDebugVariant()).toBeNull();
  });

  it("swaps in the variant manifest and shows the panel", () => {
    setUrl("?pwa-debug=b");
    expect(initPwaDebug()).toBe(true);
    expect(document.querySelector('link[rel="manifest"]')!.getAttribute("href")).toBe(manifestHrefFor("b"));
    expect(document.querySelector('[data-testid="pwa-debug-panel"]')!.textContent).toContain("variant B");
  });

  it("keeps the variant after the query string is dropped", () => {
    setUrl("?pwa-debug=c");
    getPwaDebugVariant();
    setUrl("");
    expect(getPwaDebugVariant()).toBe("c");
  });

  it("cycles theme-color through none and back to the app's colour", () => {
    setUrl("?pwa-debug=a");
    applyTheme("dark");
    initPwaDebug();
    click("theme-color ▸"); // none
    expect(themeColors()).toEqual([]);
    click("theme-color ▸"); // magenta
    expect(themeColors()).toEqual(["#ff00ff", "#ff00ff"]);
    for (let i = 0; i < 4; i += 1) click("theme-color ▸"); // ... wraps to app
    expect(themeColors()).toHaveLength(2);
  });

  it("exit restores the production manifest and forgets the variant", () => {
    setUrl("?pwa-debug=d");
    initPwaDebug();
    setUrl("");
    click("exit");
    expect(document.querySelector('link[rel="manifest"]')!.getAttribute("href")).toBe("/manifest.webmanifest");
    expect(document.querySelector('[data-testid="pwa-debug-panel"]')).toBeNull();
    expect(getPwaDebugVariant()).toBeNull();
  });
});

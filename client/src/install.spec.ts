import {
  getInstallState,
  initInstall,
  promptInstall,
  resetInstallStateForTests,
  subscribeInstallState,
} from "./install";

const fireBeforeInstallPrompt = (outcome: "accepted" | "dismissed" = "accepted") => {
  const event = new Event("beforeinstallprompt") as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ outcome: string }>;
  };
  event.prompt = vi.fn().mockResolvedValue(undefined);
  event.userChoice = Promise.resolve({ outcome });
  window.dispatchEvent(event);
  return event;
};

describe("install state", () => {
  const originalUserAgent = navigator.userAgent;

  beforeEach(() => {
    resetInstallStateForTests();
    initInstall();
  });

  afterEach(() => {
    Object.defineProperty(navigator, "userAgent", {
      value: originalUserAgent,
      configurable: true,
    });
    vi.unstubAllGlobals();
  });

  it("is manual until the browser offers a prompt", () => {
    expect(getInstallState()).toBe("manual");
  });

  it("becomes available when beforeinstallprompt fires, and notifies subscribers", () => {
    const listener = vi.fn();
    subscribeInstallState(listener);
    fireBeforeInstallPrompt();
    expect(getInstallState()).toBe("available");
    expect(listener).toHaveBeenCalled();
  });

  it("uses the prompt once and reports the user's choice", async () => {
    const event = fireBeforeInstallPrompt("accepted");
    await expect(promptInstall()).resolves.toBe(true);
    expect(event.prompt).toHaveBeenCalledTimes(1);
    // The event is spent; a second call has nothing to show.
    await expect(promptInstall()).resolves.toBe(false);
    expect(getInstallState()).toBe("manual");
  });

  it("reports a dismissed prompt as not installed", async () => {
    fireBeforeInstallPrompt("dismissed");
    await expect(promptInstall()).resolves.toBe(false);
  });

  it("is installed after appinstalled", () => {
    fireBeforeInstallPrompt();
    window.dispatchEvent(new Event("appinstalled"));
    expect(getInstallState()).toBe("installed");
  });

  it("is installed when running standalone", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(display-mode: standalone)",
    }));
    expect(getInstallState()).toBe("installed");
  });

  it("points iOS at Add to Home Screen, which has no prompt API", () => {
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
      configurable: true,
    });
    expect(getInstallState()).toBe("ios");
  });
});

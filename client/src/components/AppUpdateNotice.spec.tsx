import { act, fireEvent, render, screen } from "@testing-library/react";
import { AppUpdateNotice } from "./AppUpdateNotice";

let announce: () => void = () => {};
vi.mock("../appUpdate", () => ({
  watchForAppUpdate: ({ onUpdateAvailable }: { onUpdateAvailable: () => void }) => {
    announce = onUpdateAvailable;
    return () => {};
  },
}));

describe("AppUpdateNotice", () => {
  it("shows nothing until an update is found", () => {
    render(<AppUpdateNotice />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers a reload once an update is found, and can be dismissed", () => {
    render(<AppUpdateNotice />);
    act(() => announce());
    expect(screen.getByRole("status").textContent).toContain("new version");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

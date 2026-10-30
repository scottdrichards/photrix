import { fireEvent, render, screen } from "@testing-library/react";
import type { FeatureFlagState } from "../../../../shared/feature-flags/src/featureFlags";
import { fetchFeatureFlags, setFeatureFlagOverride } from "../../api";
import { FeatureFlagsProvider } from "../../featureFlags/FeatureFlagsContext";
import { FeatureFlagsPanel } from "./FeatureFlagsPanel";

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return { ...actual, fetchFeatureFlags: vi.fn(), setFeatureFlagOverride: vi.fn() };
});

const flag = (overrides: Partial<FeatureFlagState>): FeatureFlagState => ({
  name: "thumbnailBackfill",
  enabled: true,
  source: "default",
  description: "Pre-generate grid thumbnails",
  ...overrides,
});

const renderPanel = () =>
  render(
    <FeatureFlagsProvider>
      <FeatureFlagsPanel />
    </FeatureFlagsProvider>,
  );

describe("FeatureFlagsPanel", () => {
  it("switches a flag off and offers to reset the override", async () => {
    vi.mocked(fetchFeatureFlags).mockResolvedValue([flag({})]);
    vi.mocked(setFeatureFlagOverride).mockResolvedValue([flag({ enabled: false, source: "override" })]);
    renderPanel();

    fireEvent.click(await screen.findByRole("switch", { name: "thumbnailBackfill" }));

    expect(setFeatureFlagOverride).toHaveBeenCalledWith("thumbnailBackfill", false);
    expect(await screen.findByText("Changed here (default: on)")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "thumbnailBackfill" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Reset to default" })).toBeInTheDocument();
  });

  it("locks a flag the server pins", async () => {
    vi.mocked(fetchFeatureFlags).mockResolvedValue([flag({ source: "environment" })]);
    renderPanel();

    expect(await screen.findByRole("switch", { name: "thumbnailBackfill" })).toBeDisabled();
    expect(screen.getByText("Pinned on the server by PHOTRIX_FLAG_THUMBNAIL_BACKFILL")).toBeInTheDocument();
  });

  it("says when a change is refused", async () => {
    vi.mocked(fetchFeatureFlags).mockResolvedValue([flag({})]);
    vi.mocked(setFeatureFlagOverride).mockRejectedValue(new Error("status 500"));
    renderPanel();

    fireEvent.click(await screen.findByRole("switch", { name: "thumbnailBackfill" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't change thumbnailBackfill");
  });
});

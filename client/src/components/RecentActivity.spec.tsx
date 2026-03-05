import { render, screen } from "@testing-library/react";
import { RecentActivity } from "./RecentActivity";

describe("RecentActivity", () => {
  it("renders fallback text when no activity exists", () => {
    render(<RecentActivity label="Last EXIF" entry={null} />);

    expect(screen.getByText(/Last EXIF:/)).toBeInTheDocument();
    expect(screen.getByText("No activity yet")).toBeInTheDocument();
  });

  it("renders recent activity details", () => {
    render(
      <RecentActivity
        label="Last EXIF"
        entry={{
          folder: "trip/",
          fileName: "IMG_0001.jpg",
          completedAt: "2026-03-05T10:00:00.000Z",
        }}
      />,
    );

    expect(screen.getByText(/Last EXIF:/)).toBeInTheDocument();
    expect(screen.getByText(/trip\/IMG_0001\.jpg/)).toBeInTheDocument();
  });
});

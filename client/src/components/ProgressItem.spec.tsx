import { render, screen } from "@testing-library/react";
import { ProgressItem } from "./ProgressItem";

describe("ProgressItem", () => {
  it("renders label, percent, summary, detail, and ETA", () => {
    render(
      <ProgressItem
        label="EXIF metadata"
        progress={{ completed: 25, total: 100, percent: 0.25 }}
        summaryLabel="items processed"
        detail="75 remaining"
        eta="~5m"
      />,
    );

    expect(screen.getByText("EXIF metadata")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByText(/25 \/ 100 items processed/)).toBeInTheDocument();
    expect(screen.getByText(/75 remaining/)).toBeInTheDocument();
    expect(screen.getByText(/ETA: ~5m/)).toBeInTheDocument();
  });

  it("uses valueFormatter for summary values", () => {
    render(
      <ProgressItem
        label="Video conversion"
        progress={{ completed: 4.5, total: 12.4, percent: 0.3629 }}
        valueFormatter={(value) => `${value.toFixed(1)}m`}
      />,
    );

    expect(screen.getByText(/4.5m \/ 12.4m ready/)).toBeInTheDocument();
  });
});

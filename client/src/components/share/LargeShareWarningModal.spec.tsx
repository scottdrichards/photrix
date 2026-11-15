import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LargeShareWarningModal } from "./LargeShareWarningModal";

describe("LargeShareWarningModal", () => {
  it("says a filterless share covers the whole library (feedback #187)", () => {
    const onConfirm = vi.fn();
    render(
      <LargeShareWarningModal count={162055} wholeLibrary onConfirm={onConfirm} onCancel={vi.fn()} />,
    );

    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "your whole library (162,055 items)",
    );
    fireEvent.click(screen.getByRole("button", { name: "Share anyway" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("still warns when the size couldn't be measured", () => {
    render(<LargeShareWarningModal count={null} wholeLibrary onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByRole("alertdialog")).toHaveTextContent("your whole library.");
  });

  it("focuses Cancel so a stray Enter doesn't share", () => {
    render(<LargeShareWarningModal count={5000} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(screen.getByRole("alertdialog")).toHaveTextContent("5,000 items");
  });
});

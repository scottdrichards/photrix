import { fireEvent, render, screen } from "@testing-library/react";
import { Wordmark } from "./Wordmark";

describe("Wordmark", () => {
  it("reads as the plain word", () => {
    render(<Wordmark />);
    expect(screen.getByText("Photrix")).toBeTruthy();
  });

  it("plays the focus effect again when clicked", () => {
    const { container } = render(<Wordmark />);
    const before = container.querySelector('[data-part="rest"]');
    fireEvent.click(screen.getByText("Photrix"));
    const after = container.querySelector('[data-part="rest"]');
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });
});

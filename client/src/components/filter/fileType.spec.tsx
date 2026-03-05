import { fireEvent, render, screen } from "@testing-library/react";
import { FileTypeFilter } from "./fileType";

describe("FileTypeFilter", () => {
  it("calls handleMediaTypeChange with the selected type", () => {
    const handleMediaTypeChange = vi.fn();

    render(
      <FileTypeFilter
        mediaTypeFilter="all"
        handleMediaTypeChange={handleMediaTypeChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Photo" }));
    fireEvent.click(screen.getByRole("button", { name: "Video" }));
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    fireEvent.click(screen.getByRole("button", { name: "All" }));

    expect(handleMediaTypeChange).toHaveBeenNthCalledWith(1, "photo");
    expect(handleMediaTypeChange).toHaveBeenNthCalledWith(2, "video");
    expect(handleMediaTypeChange).toHaveBeenNthCalledWith(3, "other");
    expect(handleMediaTypeChange).toHaveBeenNthCalledWith(4, "all");
  });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FilterProvider } from "../filter/FilterContext";
import { FacesReviewPage } from ".";

const renderWithFilter = () =>
  render(
    <FilterProvider>
      <FacesReviewPage />
    </FilterProvider>,
  );

const fetchFacePeopleMock = vi.fn();
const fetchFaceQueueMock = vi.fn();
const fetchFacePersonSuggestionsMock = vi.fn();
const acceptFaceSuggestionMock = vi.fn();
const rejectFaceSuggestionMock = vi.fn();

vi.mock("../../api", () => ({
  fetchFacePeople: (...args: unknown[]) => fetchFacePeopleMock(...args),
  fetchFaceQueue: (...args: unknown[]) => fetchFaceQueueMock(...args),
  fetchFacePersonSuggestions: (...args: unknown[]) => fetchFacePersonSuggestionsMock(...args),
  acceptFaceSuggestion: (...args: unknown[]) => acceptFaceSuggestionMock(...args),
  rejectFaceSuggestion: (...args: unknown[]) => rejectFaceSuggestionMock(...args),
}));

describe("FacesReviewPage", () => {
  beforeEach(() => {
    window.history.pushState(null, "", "/");
    fetchFacePeopleMock.mockReset();
    fetchFaceQueueMock.mockReset();
    fetchFacePersonSuggestionsMock.mockReset();
    acceptFaceSuggestionMock.mockReset();
    rejectFaceSuggestionMock.mockReset();
  });

  it("shows people list first", async () => {
    fetchFacePeopleMock.mockResolvedValue([
      {
        id: "name:sam",
        name: "Sam",
        count: 3,
        representativeFace: {
          faceId: "f1",
          relativePath: "/trip/a.jpg",
          fileName: "a.jpg",
          dimensions: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
          thumbnail: { preferredHeight: 224 },
        },
      },
    ]);

    renderWithFilter();

    expect(await screen.findByText("People")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open faces for Sam" })).toBeInTheDocument();
  });

  it("passes active path filter to face API calls", async () => {
    window.history.pushState(null, "", "/trip");
    fetchFacePeopleMock.mockResolvedValue([{ id: "name:sam", name: "Sam", count: 1 }]);
    fetchFaceQueueMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 500 });
    fetchFacePersonSuggestionsMock.mockResolvedValue([]);

    renderWithFilter();

    await waitFor(() => {
      expect(fetchFacePeopleMock).toHaveBeenCalledWith({
        path: "trip/",
        includeSubfolders: true,
      });
    });

    fireEvent.click(await screen.findByRole("button", { name: "Open faces for Sam" }));

    await waitFor(() => {
      expect(fetchFaceQueueMock).toHaveBeenCalledWith({
        personId: "name:sam",
        pageSize: 500,
        path: "trip/",
        includeSubfolders: true,
      });
    });
  });

  it("loads tagged and suggested sections for a selected person", async () => {
    fetchFacePeopleMock.mockResolvedValue([{ id: "name:sam", name: "Sam", count: 2 }]);
    fetchFaceQueueMock.mockResolvedValue({
      items: [
        {
          faceId: "tagged-1",
          relativePath: "/trip/a.jpg",
          fileName: "a.jpg",
          dimensions: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
          person: { id: "name:sam", name: "Sam" },
          status: "confirmed",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 500,
    });
    fetchFacePersonSuggestionsMock.mockResolvedValue([
      {
        faceId: "suggested-1",
        relativePath: "/trip/s.jpg",
        fileName: "s.jpg",
        dimensions: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
        confidence: 0.91,
        person: null,
        status: "unverified",
      },
    ]);

    renderWithFilter();

    fireEvent.click(await screen.findByRole("button", { name: "Open faces for Sam" }));

    await waitFor(() => {
      expect(fetchFaceQueueMock).toHaveBeenCalledWith({ personId: "name:sam", pageSize: 500 });
      expect(fetchFacePersonSuggestionsMock).toHaveBeenCalledWith({
        personId: "name:sam",
        limit: 200,
      });
    });

    expect(screen.getByText("Tagged Faces")).toBeInTheDocument();
    expect(screen.getByText("Suggested Faces")).toBeInTheDocument();
    expect(screen.getByText("a.jpg")).toBeInTheDocument();
    expect(screen.getByText("s.jpg")).toBeInTheDocument();
    expect(screen.getByText("91% profile match")).toBeInTheDocument();
  });

  it("accepts and rejects profile-based suggestions", async () => {
    fetchFacePeopleMock.mockResolvedValue([{ id: "name:sam", name: "Sam", count: 2 }]);
    fetchFaceQueueMock
      .mockResolvedValueOnce({ items: [], total: 0, page: 1, pageSize: 500 })
      .mockResolvedValueOnce({
        items: [
          {
            faceId: "suggested-1",
            relativePath: "/trip/s.jpg",
            fileName: "s.jpg",
            dimensions: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
            person: { id: "name:sam", name: "Sam" },
            status: "confirmed",
          },
        ],
        total: 1,
        page: 1,
        pageSize: 500,
      })
      .mockResolvedValueOnce({
        items: [
          {
            faceId: "suggested-1",
            relativePath: "/trip/s.jpg",
            fileName: "s.jpg",
            dimensions: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
            person: { id: "name:sam", name: "Sam" },
            status: "confirmed",
          },
        ],
        total: 1,
        page: 1,
        pageSize: 500,
      });
    fetchFacePersonSuggestionsMock
      .mockResolvedValueOnce([
      {
        faceId: "suggested-1",
        relativePath: "/trip/s.jpg",
        fileName: "s.jpg",
        dimensions: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
        confidence: 0.91,
        person: null,
        status: "unverified",
      },
    ])
      .mockResolvedValueOnce([
        {
          faceId: "suggested-2",
          relativePath: "/trip/t.jpg",
          fileName: "t.jpg",
          dimensions: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
          confidence: 0.8,
          person: null,
          status: "unverified",
        },
      ])
      .mockResolvedValueOnce([]);
    acceptFaceSuggestionMock.mockResolvedValue({ ok: true, action: "accept", faceId: "suggested-1" });
    rejectFaceSuggestionMock.mockResolvedValue({ ok: true, action: "reject", faceId: "suggested-1" });

    renderWithFilter();
    fireEvent.click(await screen.findByRole("button", { name: "Open faces for Sam" }));

    await screen.findByText("s.jpg");
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    expect(screen.getByText("Assigned: Sam")).toBeInTheDocument();

    await waitFor(() => {
      expect(acceptFaceSuggestionMock).toHaveBeenCalledWith({
        faceId: "suggested-1",
        personId: "name:sam",
      });
    });

    await screen.findByText("t.jpg");

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => {
      expect(rejectFaceSuggestionMock).toHaveBeenCalledWith({
        faceId: "suggested-2",
        personId: "name:sam",
      });
    });

    await waitFor(() => {
      expect(fetchFacePersonSuggestionsMock).toHaveBeenCalledTimes(3);
    });
    expect(screen.queryByText("t.jpg")).not.toBeInTheDocument();
  });

  it("allows naming faces in unassigned bucket", async () => {
    fetchFacePeopleMock.mockResolvedValue([{ id: "__unassigned__", name: "Unassigned", count: 1 }]);
    fetchFaceQueueMock.mockResolvedValue({
      items: [
        {
          faceId: "unnamed-1",
          relativePath: "/trip/u.jpg",
          fileName: "u.jpg",
          dimensions: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
          person: null,
          status: "unverified",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 500,
    });
    acceptFaceSuggestionMock.mockResolvedValue({ ok: true, action: "accept", faceId: "unnamed-1" });

    renderWithFilter();
    fireEvent.click(await screen.findByRole("button", { name: "Open faces for Unassigned" }));

    const nameInput = await screen.findByPlaceholderText("Type a name to confirm this person");
    fireEvent.change(nameInput, { target: { value: "Jen" } });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    await waitFor(() => {
      expect(acceptFaceSuggestionMock).toHaveBeenCalledWith({
        faceId: "unnamed-1",
        personName: "Jen",
      });
    });
  });
});

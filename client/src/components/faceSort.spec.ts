import type { ClusterFace } from "../api/types";
import { sortFaces } from "./faceSort";

const face = (path: string, dateTaken: string | null): ClusterFace =>
  ({
    photo: { path, name: path, metadata: { dateTaken } },
    box: { x: 0, y: 0, width: 1, height: 1 },
    faceId: path.length,
  }) as unknown as ClusterFace;

// Server order is best match first.
const faces = [
  face("2020/b.jpg", "2020-06-01T00:00:00.000Z"),
  face("2019/a.jpg", null),
  face("2024/c.jpg", "2024-01-01T00:00:00.000Z"),
  face("2010/d.jpg", "2010-01-01T00:00:00.000Z"),
];
const paths = (list: ClusterFace[]) => list.map((f) => f.photo.path);

describe("sortFaces (feedback #144)", () => {
  it("keeps the server's best-match order, or reverses it for outliers", () => {
    expect(paths(sortFaces(faces, "match"))).toEqual(paths(faces));
    expect(paths(sortFaces(faces, "outliers"))).toEqual(paths(faces).reverse());
  });

  it("sorts by capture date with undated faces last either way", () => {
    expect(paths(sortFaces(faces, "newest"))).toEqual(["2024/c.jpg", "2020/b.jpg", "2010/d.jpg", "2019/a.jpg"]);
    expect(paths(sortFaces(faces, "oldest"))).toEqual(["2010/d.jpg", "2020/b.jpg", "2024/c.jpg", "2019/a.jpg"]);
  });

  it("sorts by folder path", () => {
    expect(paths(sortFaces(faces, "folder"))).toEqual(["2010/d.jpg", "2019/a.jpg", "2020/b.jpg", "2024/c.jpg"]);
  });

  it("never mutates the input", () => {
    const before = paths(faces);
    sortFaces(faces, "newest");
    expect(paths(faces)).toEqual(before);
  });
});

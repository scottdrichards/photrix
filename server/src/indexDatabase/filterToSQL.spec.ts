import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import Database from "better-sqlite3";
import { filterToSQL } from "./filterToSQL.ts";
import { tables } from "./tables.ts";

describe("filterToSQL", () => {
  it("returns empty where for empty filter", () => {
    const result = filterToSQL({});
    expect(result).toEqual({ where: "", params: [] });
  });

  it("builds exact string and number constraints", () => {
    const result = filterToSQL({ cameraMake: "Canon", rating: 5 });
    expect(result.where).toBe("cameraMake = ? AND rating = ?");
    expect(result.params).toEqual(["Canon", 5]);
  });

  it("builds NULL constraint", () => {
    const result = filterToSQL({ dateTaken: null });
    expect(result.where).toBe("dateTaken IS NULL");
    expect(result.params).toEqual([]);
  });

  it("builds date range constraints with timestamps", () => {
    const min = new Date("2024-01-01T00:00:00.000Z");
    const max = new Date("2024-12-31T23:59:59.999Z");

    const result = filterToSQL({ dateTaken: { min, max } });

    expect(result.where).toBe("dateTaken >= ? AND dateTaken <= ?");
    expect(result.params).toEqual([min.getTime(), max.getTime()]);
  });

  it("builds folder recursive constraint", () => {
    const result = filterToSQL({ folder: { folder: "albums/2024", recursive: true } });
    expect(result.where).toBe("folder LIKE ? ESCAPE '\\'");
    expect(result.params).toEqual(["/albums/2024/%"]);
  });

  it("omits where clause for root recursive folder filter", () => {
    const result = filterToSQL({ folder: { folder: "/", recursive: true } });
    expect(result).toEqual({ where: "", params: [] });
  });

  it("builds json-array contains lookup for tags", () => {
    const result = filterToSQL({ tags: "family" });
    expect(result.where).toContain("json_each(tags)");
    expect(result.params).toEqual(["family"]);
  });

  it("requires all values for non-mutually-exclusive json array fields", () => {
    const result = filterToSQL({ tags: ["family", "vacation"] });

    expect(result.where).toBe(
      "EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?) AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)",
    );
    expect(result.params).toEqual(["family", "vacation"]);
  });

  it("matches any value for mutually-exclusive scalar fields", () => {
    const result = filterToSQL({ cameraModel: ["R6", "A7 IV"] });

    expect(result.where).toBe("(cameraModel = ? OR cameraModel = ?)");
    expect(result.params).toEqual(["R6", "A7 IV"]);
  });

  it("treats an empty array constraint as matching nothing", () => {
    const result = filterToSQL({ relativePath: [] });

    expect(result).toEqual({ where: "1 = 0", params: [] });
  });

  it("builds glob search with LIKE", () => {
    const result = filterToSQL({ fileName: { glob: "IMG_*.jpg" } });
    expect(result.where).toBe("fileName LIKE ?");
    expect(result.params).toEqual(["IMG_%.jpg"]);
  });

  it("builds relativePath regex search using folder and fileName", () => {
    const result = filterToSQL({ relativePath: { regex: ".*\\.heic$" } });
    expect(result.where).toBe("(folder || fileName) REGEXP ?");
    expect(result.params).toEqual([".*\\.heic$"]);
  });

  it("builds nested logical filters", () => {
    const result = filterToSQL({
      operation: "or",
      conditions: [{ cameraMake: "Canon" }, { cameraMake: "Nikon" }],
    });

    expect(result.where).toBe("(cameraMake = ?) OR (cameraMake = ?)");
    expect(result.params).toEqual(["Canon", "Nikon"]);
  });

  it("filters for files that have at least one face row", () => {
    const result = filterToSQL({ hasFaces: true });
    expect(result.where).toBe(
      "EXISTS (SELECT 1 FROM faces WHERE faces.folder = files.folder AND faces.fileName = files.fileName)",
    );
    expect(result.params).toEqual([]);
  });

  it("filters for files without face rows", () => {
    const result = filterToSQL({ hasFaces: false });
    expect(result.where).toBe(
      "NOT EXISTS (SELECT 1 FROM faces WHERE faces.folder = files.folder AND faces.fileName = files.fileName)",
    );
    expect(result.params).toEqual([]);
  });

  it("requires a face from every selected person (AND semantics)", () => {
    const result = filterToSQL({ faceCluster: [3, 12] });
    expect(result.where).toBe(
      "EXISTS (SELECT 1 FROM faces JOIN faceClusters ON faceClusters.id = faces.clusterId WHERE faces.folder = files.folder AND faces.fileName = files.fileName AND COALESCE(faceClusters.personId, faces.clusterId) = ?) AND EXISTS (SELECT 1 FROM faces JOIN faceClusters ON faceClusters.id = faces.clusterId WHERE faces.folder = files.folder AND faces.fileName = files.fileName AND COALESCE(faceClusters.personId, faces.clusterId) = ?)",
    );
    expect(result.params).toEqual([3, 12]);
  });

  it("accepts a single cluster id", () => {
    const result = filterToSQL({ faceCluster: 7 });
    expect(result.where).toBe(
      "EXISTS (SELECT 1 FROM faces JOIN faceClusters ON faceClusters.id = faces.clusterId WHERE faces.folder = files.folder AND faces.fileName = files.fileName AND COALESCE(faceClusters.personId, faces.clusterId) = ?)",
    );
    expect(result.params).toEqual([7]);
  });

  describe("faceMatch (person + photo-ready attributes)", () => {
    it("constrains the selected person's own face, not a separate one", () => {
      const result = filterToSQL({
        faceMatch: { clusterIds: [3], attributes: ["smiling", "eyesOpen"] },
      });

      // One EXISTS carrying both the person and the attributes. Two sibling
      // EXISTS clauses would wrongly match "a photo of person 3 that also
      // contains somebody smiling".
      expect(result.where.match(/EXISTS/g)).toHaveLength(1);
      expect(result.where).toBe(
        "EXISTS (SELECT 1 FROM faces JOIN faceClusters ON faceClusters.id = faces.clusterId" +
          " WHERE faces.folder = files.folder AND faces.fileName = files.fileName" +
          " AND COALESCE(faceClusters.personId, faces.clusterId) = ?" +
          " AND (faces.smileScore IS NULL OR faces.smileScore >= ?)" +
          " AND (faces.eyesOpenScore IS NULL OR faces.eyesOpenScore >= ?))",
      );
      expect(result.params).toEqual([3, 0.5, 0.5]);
    });

    it("repeats the attribute constraints per selected person", () => {
      const result = filterToSQL({
        faceMatch: { clusterIds: [3, 12], attributes: ["smiling"] },
      });

      expect(result.where.match(/EXISTS/g)).toHaveLength(2);
      // Params interleave: each person's id is followed by that clause's own
      // attribute thresholds, matching the placeholder order.
      expect(result.params).toEqual([3, 0.5, 12, 0.5]);
    });

    it("treats unscored faces as matching by default", () => {
      const result = filterToSQL({ faceMatch: { attributes: ["inFocus"] } });

      expect(result.where).toBe(
        "EXISTS (SELECT 1 FROM faces WHERE faces.folder = files.folder" +
          " AND faces.fileName = files.fileName" +
          " AND (faces.focusScore IS NULL OR faces.focusScore >= ?))",
      );
      expect(result.params).toEqual([0.5]);
    });

    it("excludes unscored faces when the user opts in", () => {
      const result = filterToSQL({
        faceMatch: { attributes: ["inFocus"], includeUnknown: false },
      });

      expect(result.where).toBe(
        "EXISTS (SELECT 1 FROM faces WHERE faces.folder = files.folder" +
          " AND faces.fileName = files.fileName AND faces.focusScore >= ?)",
      );
      expect(result.params).toEqual([0.5]);
    });

    it("emits attribute conditions in canonical order regardless of input order", () => {
      const forward = filterToSQL({
        faceMatch: { attributes: ["smiling", "wellExposed"] },
      });
      const reversed = filterToSQL({
        faceMatch: { attributes: ["wellExposed", "smiling"] },
      });

      expect(reversed).toEqual(forward);
    });

    it("ignores unrecognised attribute names", () => {
      const result = filterToSQL({
        faceMatch: {
          clusterIds: [4],
          attributes: ["smiling", "wearingAHat"],
        } as never,
      });

      expect(result.where).not.toContain("wearingAHat");
      expect(result.params).toEqual([4, 0.5]);
    });

    it("degrades to the plain person filter when no attributes are given", () => {
      const withEmptyAttributes = filterToSQL({
        faceMatch: { clusterIds: [7], attributes: [] },
      });
      const plain = filterToSQL({ faceCluster: 7 });

      expect(withEmptyAttributes).toEqual(plain);
    });

    it("is a no-op when neither people nor attributes are selected", () => {
      expect(filterToSQL({ faceMatch: {} })).toEqual({ where: "", params: [] });
      expect(filterToSQL({ faceMatch: null })).toEqual({ where: "", params: [] });
    });

    it("only reads face columns carried by the by_file_v4 index", () => {
      // Regression guard for the perf fix this index exists for: a face column
      // outside the index turns the EXISTS probe into a row fetch, which drags
      // the ~4 KB embedding BLOB page per row (measured ~28s vs sub-second over
      // the library).
      const indexed = new Set(
        tables.faces.compositeIndexes
          .find((index) => index.name === "by_file_v4")!
          .expression.split(",")
          .map((column) => column.trim()),
      );

      const { where } = filterToSQL({
        faceMatch: {
          clusterIds: [3],
          attributes: ["smiling", "eyesOpen", "inFocus", "wellExposed"],
        },
      });

      const referenced = [...where.matchAll(/faces\.(\w+)/g)].map((match) => match[1]);
      expect(referenced.length).toBeGreaterThan(0);
      for (const column of referenced) {
        expect(indexed).toContain(column);
      }
    });

    describe("multi-person gating against real rows", () => {
      // The unit tests above check the shape of the generated SQL string; this
      // block actually executes it against an in-memory DB to verify the
      // behavior the shape is supposed to guarantee: with two selected people,
      // EACH person's own face must independently satisfy the attributes.
      // Someone else in the same photo (not selected) is exempt — a background
      // stranger with their eyes closed must not disqualify the match.
      let db: Database.Database;

      const createSchema = () => {
        const columnDefs = (name: keyof typeof tables) =>
          tables[name].columns
            .map((c) => `${c.name} ${c.type}${c.isPrimaryKey ? " PRIMARY KEY" : ""}`)
            .join(", ");

        db.exec(`CREATE TABLE files (${columnDefs("files")})`);
        db.exec(`CREATE TABLE faces (${columnDefs("faces")})`);
        db.exec(`CREATE TABLE faceClusters (${columnDefs("faceClusters")})`);
      };

      const insertFile = (folder: string, fileName: string) => {
        db.prepare("INSERT INTO files (folder, fileName) VALUES (?, ?)").run(
          folder,
          fileName,
        );
      };

      const insertFace = (face: {
        folder: string;
        fileName: string;
        clusterId: number;
        smileScore?: number | null;
        eyesOpenScore?: number | null;
      }) => {
        db.prepare(
          `INSERT INTO faces (folder, fileName, clusterId, smileScore, eyesOpenScore)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          face.folder,
          face.fileName,
          face.clusterId,
          face.smileScore ?? null,
          face.eyesOpenScore ?? null,
        );
      };

      const insertCluster = (id: number) => {
        db.prepare("INSERT INTO faceClusters (id) VALUES (?)").run(id);
      };

      const matchedFile = (
        clusterIds: number[],
        attributes: ("smiling" | "eyesOpen")[],
      ): boolean => {
        const { where, params } = filterToSQL({
          faceMatch: { clusterIds, attributes, includeUnknown: false },
        });
        const row = db
          .prepare(`SELECT 1 AS matched FROM files WHERE ${where}`)
          .get(...(params as never[]));
        return row !== undefined;
      };

      beforeEach(() => {
        db = new Database(":memory:");
        createSchema();
        insertCluster(1); // person A
        insertCluster(2); // person B
        insertCluster(3); // unselected bystander
      });

      afterEach(() => {
        db.close();
      });

      it("finds zero matches when only one of two selected people is photo-ready", () => {
        insertFile("/album/", "both-selected-one-not-ready.jpg");
        // Person A (cluster 1): smiling and eyes open — ready.
        insertFace({
          folder: "/album/",
          fileName: "both-selected-one-not-ready.jpg",
          clusterId: 1,
          smileScore: 0.9,
          eyesOpenScore: 0.9,
        });
        // Person B (cluster 2): selected too, but eyes closed — not ready.
        insertFace({
          folder: "/album/",
          fileName: "both-selected-one-not-ready.jpg",
          clusterId: 2,
          smileScore: 0.9,
          eyesOpenScore: 0.05,
        });

        expect(matchedFile([1, 2], ["smiling", "eyesOpen"])).toBe(false);
      });

      it("matches when both selected people are independently photo-ready", () => {
        insertFile("/album/", "both-selected-both-ready.jpg");
        insertFace({
          folder: "/album/",
          fileName: "both-selected-both-ready.jpg",
          clusterId: 1,
          smileScore: 0.9,
          eyesOpenScore: 0.9,
        });
        insertFace({
          folder: "/album/",
          fileName: "both-selected-both-ready.jpg",
          clusterId: 2,
          smileScore: 0.8,
          eyesOpenScore: 0.7,
        });

        expect(matchedFile([1, 2], ["smiling", "eyesOpen"])).toBe(true);
      });

      it("exempts an unselected bystander from the attribute gate", () => {
        insertFile("/album/", "bystander-eyes-closed.jpg");
        // Only person A is selected, and is photo-ready.
        insertFace({
          folder: "/album/",
          fileName: "bystander-eyes-closed.jpg",
          clusterId: 1,
          smileScore: 0.9,
          eyesOpenScore: 0.9,
        });
        // Cluster 3 is a bystander in the same photo who is NOT selected and
        // has their eyes closed — this must not disqualify the match.
        insertFace({
          folder: "/album/",
          fileName: "bystander-eyes-closed.jpg",
          clusterId: 3,
          smileScore: 0.1,
          eyesOpenScore: 0.02,
        });

        expect(matchedFile([1], ["smiling", "eyesOpen"])).toBe(true);
      });
    });
  });

  it("builds runtime semantic image constraints", () => {
    const result = filterToSQL({
      semanticImage: { queryVector: [0.1, 0.2], minSimilarity: 0.18 },
    });

    expect(result.where).toContain("cosine_similarity_f32(imageEmbedding, ?) >= ?");
    expect(result.params).toHaveLength(2);
    expect(result.params[0]).toBeInstanceOf(Buffer);
    expect(result.params[1]).toBe(0.18);
  });

  it("builds runtime transcript constraints", () => {
    const result = filterToSQL({ transcriptSearch: { includes: "sunset" } });

    expect(result.where).toBe("audioTranscript LIKE ? ESCAPE '\\'");
    expect(result.params).toEqual(["%sunset%"]);
  });
});

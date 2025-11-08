import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IndexDatabase } from "./indexDatabase.js";
import type { DatabaseFileEntry, FileInfo } from "./fileRecord.type.js";

const EXAMPLE_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../exampleFolder",
);

const createEntry = (overrides: Partial<DatabaseFileEntry> = {}): DatabaseFileEntry => {
	const base: DatabaseFileEntry = {
		relativePath: "sewing-threads.heic",
		mimeType: "image/heic",
		info: {
			sizeInBytes: 1024,
			created: new Date("2020-01-01T00:00:00Z"),
			modified: new Date("2020-01-02T00:00:00Z"),
		},
	};
	return { ...base, ...overrides };
};

const accessEntries = (db: IndexDatabase): Record<string, DatabaseFileEntry> => {
	return (db as unknown as { entries: Record<string, DatabaseFileEntry> }).entries;
};

describe("IndexDatabase", () => {
	it("adds files without mutating original input", async () => {
		const db = new IndexDatabase();
		const entry = createEntry();

		await db.addFile(entry);
		entry.info.sizeInBytes = 1;
		entry.exifMetadata.cameraMake = "changed";

		const record = await db.getFileRecord(entry.relativePath);

		expect(record?.sizeInBytes).toBe(1024);
		expect(record?.cameraMake).toBeUndefined();
	});

	it("removes files from the database", async () => {
		const db = new IndexDatabase();
		const entry = createEntry();

		await db.addFile(entry);
		await db.removeFile(entry.relativePath);

		const record = await db.getFileRecord(entry.relativePath);
		expect(record).toBeUndefined();
	});

	it("merges updates when addOrUpdateFileData is called", async () => {
		const db = new IndexDatabase();
		const entry = createEntry();

		await db.addFile(entry);
		await db.addOrUpdateFileData(entry.relativePath, {
			info: {
				sizeInBytes: 2048,
				created: new Date("2021-01-01T00:00:00Z"),
				modified: new Date("2021-01-02T00:00:00Z"),
			},
			exifMetadata: { cameraMake: "Canon" },
		});

		const record = await db.getFileRecord(entry.relativePath);
		expect(record?.sizeInBytes).toBe(2048);
		expect(record?.cameraMake).toBe("Canon");
		expect(record?.mimeType).toBe("image/heic");
	});

	it("returns undefined for unknown files", async () => {
		const db = new IndexDatabase();
		const record = await db.getFileRecord("missing.file");
		expect(record).toBeUndefined();
	});

	it("loads missing metadata from disk when storagePath is provided", async () => {
		const db = new IndexDatabase(EXAMPLE_ROOT);
		const entry = createEntry();

		await db.addFile(entry);
		const record = await db.getFileRecord(entry.relativePath, ["created", "cameraMake"]);

		expect(record?.sizeInBytes).toBeGreaterThan(0);
		expect(record?.cameraMake?.toLowerCase()).toBe("samsung");

		const stored = accessEntries(db)[entry.relativePath];
		expect(stored.info.sizeInBytes).toBe(record?.sizeInBytes);
		expect(stored.exifMetadata.cameraMake).toBe(record?.cameraMake);
	});
});

import { describe, it, expect } from "@jest/globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IndexDatabase } from "./indexDatabase.ts";
import type { DatabaseFileEntry } from "./fileRecord.type.ts";

const EXAMPLE_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../exampleFolder",
);

const DEFAULT_INFO = {
	sizeInBytes: 1024,
	created: new Date("2020-01-01T00:00:00Z"),
	modified: new Date("2020-01-02T00:00:00Z"),
} as const;

const createEntry = (overrides: Partial<DatabaseFileEntry> = {}): DatabaseFileEntry => {
	const base = {
		relativePath: "sewing-threads.heic",
		mimeType: "image/heic",
		info: DEFAULT_INFO,
		exifMetadata: {},
		aiMetadata: {},
		faceMetadata: {},
	} as const satisfies DatabaseFileEntry;
	return {
		...base,
		...overrides,
		info: {
			...base.info,
			...(overrides.info ?? {}),
		},
	};
};

const createDb = (): IndexDatabase => new IndexDatabase(EXAMPLE_ROOT);

describe("IndexDatabase", () => {
	it("adds files without mutating original input", async () => {
		const db = createDb();
		const entry = createEntry();

		await db.addFile(entry);
		entry.info!.sizeInBytes = 1;
		entry.exifMetadata!.cameraMake = "changed";

		const record = await db.getFileRecord(entry.relativePath);

		expect(record?.sizeInBytes).toBe(1024);
		expect(record?.cameraMake).toBeUndefined();
	});

	it("removes files from the database", async () => {
		const db = createDb();
		const entry = createEntry();

		await db.addFile(entry);
		await db.removeFile(entry.relativePath);

		const record = await db.getFileRecord(entry.relativePath);
		expect(record).toBeUndefined();
	});

	it("moves a file to a new relative path", async () => {
		const db = createDb();
		const entry = createEntry();

		await db.addFile(entry);
		await db.moveFile(entry.relativePath, "new-folder/renamed.heic");

		const oldRecord = await db.getFileRecord(entry.relativePath);
		const newRecord = await db.getFileRecord("new-folder/renamed.heic");

		expect(oldRecord).toBeUndefined();
		expect(newRecord?.relativePath).toBe("new-folder/renamed.heic");
		expect(newRecord?.mimeType).toBe(entry.mimeType);
		expect(newRecord?.sizeInBytes).toBe(entry.info!.sizeInBytes);
	});

	it("merges updates when addOrUpdateFileData is called", async () => {
		const db = createDb();
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
		const db = createDb();
		const record = await db.getFileRecord("missing.file");
		expect(record).toBeUndefined();
	});

});

import { describe, it, expect, beforeAll } from "@jest/globals";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import type { DatabaseFileEntry } from "./fileRecord.type.ts";
import { IndexDatabase } from "./indexDatabase.ts";

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
		...DEFAULT_INFO,
	} as const satisfies DatabaseFileEntry;
	return {
		...base,
		...overrides,
	};
};

const createDb = (): InstanceType<typeof IndexDatabase> => new IndexDatabase(EXAMPLE_ROOT);

beforeAll(async () => {
	process.env.ThumbnailCacheDirectory ??= path.join(os.tmpdir(), "photrix-test-thumbs");
	process.env.INDEX_DB_PATH = path.join(os.tmpdir(), "photrix-test-index.db");
});

const cleanDb = () => {
	try {
		rmSync(process.env.INDEX_DB_PATH ?? "", { force: true });
	} catch {
		/* ignore */
	}
};

describe("IndexDatabase", () => {
	it("adds files without mutating original input", async () => {
		cleanDb();
		const db = createDb();
		const entry = createEntry();

		await db.addFile(entry);
		(entry as any).sizeInBytes = 1;
		(entry as any).cameraMake = "changed";

		const record = await db.getFileRecord(entry.relativePath);

		expect(record?.sizeInBytes).toBe(1024);
		expect(record?.cameraMake).toBeUndefined();
	});

	it("removes files from the database", async () => {
		cleanDb();
		const db = createDb();
		const entry = createEntry();

		await db.addFile(entry);
		await db.removeFile(entry.relativePath);

		const record = await db.getFileRecord(entry.relativePath);
		expect(record).toBeUndefined();
	});

	it("moves a file to a new relative path", async () => {
		cleanDb();
		const db = createDb();
		const entry = createEntry();

		await db.addFile(entry);
		await db.moveFile(entry.relativePath, "new-folder/renamed.heic");

		const oldRecord = await db.getFileRecord(entry.relativePath);
		const newRecord = await db.getFileRecord("new-folder/renamed.heic");

		expect(oldRecord).toBeUndefined();
		expect(newRecord?.relativePath).toBe("new-folder/renamed.heic");
		expect(newRecord?.mimeType).toBe(entry.mimeType);
		expect(newRecord?.sizeInBytes).toBe(entry.sizeInBytes);
	});

	it("merges updates when addOrUpdateFileData is called", async () => {
		cleanDb();
		const db = createDb();
		const entry = createEntry();

		await db.addFile(entry);
		await db.addOrUpdateFileData(entry.relativePath, {
			sizeInBytes: 2048,
			created: new Date("2021-01-01T00:00:00Z"),
			modified: new Date("2021-01-02T00:00:00Z"),
			cameraMake: "Canon",
		});

		const record = await db.getFileRecord(entry.relativePath);
		expect(record?.sizeInBytes).toBe(2048);
		expect(record?.cameraMake).toBe("Canon");
		expect(record?.mimeType).toBe("image/heic");
	});

	it("returns undefined for unknown files", async () => {
		cleanDb();
		const db = createDb();
		const record = await db.getFileRecord("missing.file");
		expect(record).toBeUndefined();
	});

});

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
		await db.load();
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
		await db.load();
		const entry = createEntry();

		await db.addFile(entry);
		await db.removeFile(entry.relativePath);

		const record = await db.getFileRecord(entry.relativePath);
		expect(record).toBeUndefined();
	});

	it("moves a file to a new relative path", async () => {
		cleanDb();
		const db = createDb();
		await db.load();
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
		await db.load();
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
		await db.load();
		const record = await db.getFileRecord("missing.file");
		expect(record).toBeUndefined();
	});

	it("correctly stores and retrieves sizeInBytes", async () => {
		cleanDb();
		const db = createDb();
		await db.load();
		
		const entry = createEntry({ sizeInBytes: 12345 });
		await db.addFile(entry);

		const record = await db.getFileRecord(entry.relativePath);
		expect(record?.sizeInBytes).toBe(12345);
		expect(typeof record?.sizeInBytes).toBe("number");
	});

	it("correctly stores and retrieves created date", async () => {
		cleanDb();
		const db = createDb();
		await db.load();
		
		const createdDate = new Date("2023-06-15T14:30:00.000Z");
		const entry = createEntry({ created: createdDate });
		await db.addFile(entry);

		const record = await db.getFileRecord(entry.relativePath);
		expect(record?.created).toBeInstanceOf(Date);
		expect(record?.created?.getTime()).toBe(createdDate.getTime());
	});

	it("correctly stores and retrieves modified date", async () => {
		cleanDb();
		const db = createDb();
		await db.load();
		
		const modifiedDate = new Date("2024-03-20T09:15:30.500Z");
		const entry = createEntry({ modified: modifiedDate });
		await db.addFile(entry);

		const record = await db.getFileRecord(entry.relativePath);
		expect(record?.modified).toBeInstanceOf(Date);
		expect(record?.modified?.getTime()).toBe(modifiedDate.getTime());
	});

	it("correctly stores and retrieves dateTaken", async () => {
		cleanDb();
		const db = createDb();
		await db.load();
		
		const dateTaken = new Date("2019-08-25T16:45:00.000Z");
		const entry = createEntry({ dateTaken });
		await db.addFile(entry);

		const record = await db.getFileRecord(entry.relativePath);
		expect(record?.dateTaken).toBeInstanceOf(Date);
		expect(record?.dateTaken?.getTime()).toBe(dateTaken.getTime());
	});

	it("preserves millisecond precision in dates", async () => {
		cleanDb();
		const db = createDb();
		await db.load();
		
		const dateWithMillis = new Date("2022-11-10T18:22:33.789Z");
		const entry = createEntry({
			created: dateWithMillis,
			modified: dateWithMillis,
			dateTaken: dateWithMillis,
		});
		await db.addFile(entry);

		const record = await db.getFileRecord(entry.relativePath);
		expect(record?.created?.getTime()).toBe(dateWithMillis.getTime());
		expect(record?.modified?.getTime()).toBe(dateWithMillis.getTime());
		expect(record?.dateTaken?.getTime()).toBe(dateWithMillis.getTime());
	});

	it("handles zero sizeInBytes correctly", async () => {
		cleanDb();
		const db = createDb();
		await db.load();
		
		const entry = createEntry({ sizeInBytes: 0 });
		await db.addFile(entry);

		const record = await db.getFileRecord(entry.relativePath);
		expect(record?.sizeInBytes).toBe(0);
	});

	it("updates dates when using addOrUpdateFileData", async () => {
		cleanDb();
		const db = createDb();
		await db.load();
		
		const originalDate = new Date("2020-01-01T00:00:00.000Z");
		const updatedDate = new Date("2024-12-07T12:00:00.000Z");
		
		const entry = createEntry({ created: originalDate });
		await db.addFile(entry);
		
		await db.addOrUpdateFileData(entry.relativePath, {
			created: updatedDate,
			dateTaken: updatedDate,
		});

		const record = await db.getFileRecord(entry.relativePath);
		expect(record?.created?.getTime()).toBe(updatedDate.getTime());
		expect(record?.dateTaken?.getTime()).toBe(updatedDate.getTime());
	});

	it("stores location with decimal GPS coordinates", async () => {
		cleanDb();
		const db = createDb();
		await db.load();
		
		const entry = createEntry();
		await db.addFile(entry);
		
		await db.addOrUpdateFileData(entry.relativePath, {
			location: {
				latitude: 40.70609666666667,
				longitude: 110.93284,
			},
		});

		const record = await db.getFileRecord(entry.relativePath);
		expect(record?.location?.latitude).toBeCloseTo(40.70609666666667, 5);
		expect(record?.location?.longitude).toBeCloseTo(110.93284, 5);
	});

	it("handles metadata from JPG with GPS location without SQL errors", async () => {
		// This test simulates the exact error that was occurring
		// The problematic JPG file had GPS data as arrays, not decimals
		cleanDb();
		const db = createDb();
		await db.load();
		
		const relativePath = "subFolder/20120803_160939.jpg";
		const entry = createEntry({ relativePath, mimeType: "image/jpeg" });
		await db.addFile(entry);
		
		// Simulate the metadata that would be extracted from the JPG
		// (converted from DMS array format to decimal degrees)
		await db.addOrUpdateFileData(relativePath, {
			dimensions: { width: 3264, height: 2448 },
			location: {
				latitude: 40.70609666666667,
				longitude: 110.93284,
			},
			cameraMake: "SAMSUNG",
			cameraModel: "SGH-T989",
			exposureTime: 0.9,
			focalLength: 4.03,
			orientation: 1,
			exifProcessedAt: new Date().toISOString(),
		});

		// Verify all metadata was stored correctly
		const record = await db.getFileRecord(relativePath);
		expect(record).toBeDefined();
		expect(record?.dimensions?.width).toBe(3264);
		expect(record?.dimensions?.height).toBe(2448);
		expect(record?.location?.latitude).toBeCloseTo(40.706096, 4);
		expect(record?.location?.longitude).toBeCloseTo(110.932840, 4);
		expect(record?.cameraMake).toBe("SAMSUNG");
		expect(record?.cameraModel).toBe("SGH-T989");
	});

});
